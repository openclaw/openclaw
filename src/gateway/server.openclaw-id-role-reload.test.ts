import fs from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import {
  formatIrohEndpointKey,
  randomBytes,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfig, writeConfigFile, type OpenClawConfig } from "../config/config.js";
import {
  getRuntimeConfigSnapshot,
  hasManagedRuntimeConfigWriteOwner,
} from "../config/runtime-snapshot.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import * as presetActivation from "./openclaw-id/member-role-presets.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.test-support.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { isOpenClawIdTunnelPrincipalAdmitted } from "./openclaw-id/tunnel-principal.js";
import { startGatewayServerCore } from "./server-start.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";

it("activates presets without breaking device-token reconnect, and reloads a member's custom definition", async ({
  signal,
}) => {
  const state = await createOpenClawTestState(kernelGatewayTestStateOptions("member-role-reload"));
  const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const requestRecoveryRestart = vi.fn();
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const token = "member-role-reload-test-token";
  const memberOrigin = "http://member.test";
  const peer = formatIrohEndpointKey(randomBytes(32));
  // oxlint-disable-next-line typescript/unbound-method -- The observer supplies the original server receiver.
  const emit = http.Server.prototype.emit;
  const intercepted = vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
    this: http.Server,
    event,
    ...args
  ) {
    if (event === "upgrade" || event === "request") {
      const req = args[0] as IncomingMessage;
      if (req.headers.origin === memberOrigin) {
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey: peer,
          clientIp: "fd7a:115c:a1e0::1",
        });
      }
    }
    return emit.call(this, event, ...args);
  });
  const apply = async (config: OpenClawConfig) => {
    const application = createRuntimeConfigWriteApplication();
    await writeConfigFile(config, attachRuntimeConfigWriteApplication({}, application));
    expect(await withinTest(application.result, signal)).toBe("applied");
  };
  try {
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { allowedOrigins: [origin, memberOrigin] },
      },
    });
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "role-member",
          role: "guest",
          peer_keys: [peer],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    await claw.authority.bindToken("previous-member-browser", "operator", peer);
    server = await startGatewayServerCore(port, {
      bind: "loopback",
      controlUiEnabled: false,
      hotReloadRecovery: requestRecoveryRestart,
    });
    let ownerHello: HelloOk | undefined;
    const owner = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: ["operator.admin"],
      onHelloOk: (hello) => {
        ownerHello = hello;
      },
      signal,
    });
    clients.push(owner);
    const deviceToken = ownerHello?.auth.deviceToken;
    expect(deviceToken).toBeTruthy();
    await owner.stopAndWait();
    const initial = getRuntimeConfig();
    await apply({ ...initial, gateway: { ...initial.gateway, openclawId: { enabled: true } } });
    await expect
      .poll(() => getRuntimeConfig().gateway?.roles?.definitions.operator)
      .toEqual(MEMBER_ROLE_PRESETS.operator);
    expect(getRuntimeConfig().gateway?.roles?.default).toBeUndefined();
    const reconnect = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      deviceToken,
      scopes: ["operator.admin"],
      signal,
    });
    clients.push(reconnect);
    await reconnect.request("device.pair.list", {});
    const config = structuredClone(getRuntimeConfig());
    config.gateway!.roles!.definitions.guest = {
      sessions: { others: "write" },
      agents: "*",
      scopes: ["operator.admin"],
    };
    await apply(config);
    const connectMember = async () => {
      const closed = createDeferredCore<number>();
      let hello: HelloOk | undefined;
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        origin: memberOrigin,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        scopes: ["operator.admin", "operator.pairing"],
        onHelloOk: (value) => {
          hello = value;
        },
        onClose: (code) => {
          closed.resolve(code);
        },
        signal,
      });
      clients.push(client);
      return { client, hello, closed };
    };
    const member = await connectMember();
    expect(member.hello?.auth.roleAllowsAdmin).toBe(true);
    expect(member.hello?.auth.scopes).toContain("operator.admin");
    await member.client.request("device.pair.list", {});
    config.gateway!.roles!.definitions.guest = MEMBER_ROLE_PRESETS.viewer;
    await apply(config);
    expect(await withinTest(member.closed.promise, signal)).toBe(4001);
    await member.client.stopAndWait();
    const viewer = await connectMember();
    expect(viewer.hello?.auth.roleAllowsAdmin).toBe(false);
    expect(viewer.hello?.auth.scopes).toEqual(["operator.sessions.read"]);
    await viewer.client.request("sessions.list", {});
    await expect(viewer.client.request("logs.tail", {})).rejects.toThrow();
    await expect(viewer.client.request("users.list", {})).rejects.toThrow();
    delete config.gateway!.roles!.definitions.guest;
    await apply(config);
    expect(await withinTest(viewer.closed.promise, signal)).toBe(4001);
    await viewer.client.stopAndWait();
    await expect(connectMember()).rejects.toThrow();
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  } finally {
    for (const client of clients) {
      await client.stopAndWait();
    }
    await server?.close();
    intercepted.mockRestore();
    await state.cleanup();
  }
});

it("orders delayed startup presets before live policy and reports reload-off activation", async ({
  signal,
}) => {
  const state = await createOpenClawTestState(
    kernelGatewayTestStateOptions("member-role-startup-off"),
  );
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const createActivation = presetActivation.createMemberRolePresetActivation;
  const delayed = vi
    .spyOn(presetActivation, "createMemberRolePresetActivation")
    .mockImplementation((log) => {
      const activation = createActivation(log);
      return {
        ...activation,
        async reconcile(enabled) {
          if (enabled) {
            entered.resolve();
            await release.promise;
          }
          return activation.reconcile(enabled);
        },
      };
    });
  let starting: ReturnType<typeof startGatewayServerCore> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  const requestRecoveryRestart = vi.fn();
  let owner: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  const apply = async (config: OpenClawConfig) => {
    const application = createRuntimeConfigWriteApplication();
    await writeConfigFile(config, attachRuntimeConfigWriteApplication({}, application));
    return withinTest(application.result, signal);
  };
  try {
    const port = await getFreePort();
    const token = "member-role-startup-test-token";
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        reload: { mode: "off" },
        openclawId: { enabled: true },
      },
    });
    starting = startGatewayServerCore(port, {
      bind: "loopback",
      controlUiEnabled: false,
      hotReloadRecovery: requestRecoveryRestart,
    });
    await withinTest(entered.promise, signal);
    const publishedBeforePresets = getRuntimeConfigSnapshot()?.gateway?.openclawId?.enabled;
    const managedBeforePresets = hasManagedRuntimeConfigWriteOwner(state.configPath);
    release.resolve();
    server = await starting;
    expect(publishedBeforePresets).not.toBe(true);
    expect(managedBeforePresets).toBe(false);
    expect(getRuntimeConfig().gateway?.roles).toEqual({ definitions: MEMBER_ROLE_PRESETS });
    expect(
      JSON.parse(await fs.readFile(state.configPath, "utf8")).gateway.roles.definitions,
    ).toEqual(MEMBER_ROLE_PRESETS);
    expect(
      isOpenClawIdTunnelPrincipalAdmitted({
        kind: "member",
        peerKey: `iroh:${"ab".repeat(32)}`,
        accountId: "existing",
        role: "operator",
      }),
    ).toBe(true);
    owner = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      scopes: ["operator.admin"],
      signal,
    });
    const config = structuredClone(getRuntimeConfig());
    config.gateway!.openclawId = { enabled: false };
    config.gateway!.reload = { mode: "hybrid" };
    expect(await apply(config)).toBe("applied");
    const disabled = structuredClone(getRuntimeConfig());
    expect(
      await apply({
        ...disabled,
        gateway: { ...disabled.gateway, reload: { mode: "off" }, openclawId: { enabled: true } },
      }),
    ).toBe("failed");
    expect(getRuntimeConfig().gateway?.openclawId?.enabled).toBe(false);
    expect(await owner.request("openclawId.status", {})).toMatchObject({
      status: {
        state: "failed",
        reason: expect.stringContaining("Restart the Gateway to finish turning on"),
      },
    });
    expect(await apply(disabled)).toBe("applied");
    expect(await owner.request("openclawId.status", {})).toMatchObject({
      status: { state: "off" },
    });
    expect(requestRecoveryRestart).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await owner?.stopAndWait();
    server ??= await starting?.catch(() => undefined);
    await server?.close();
    delayed.mockRestore();
    await state.cleanup();
  }
});
