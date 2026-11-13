import fs from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  formatIrohEndpointKey,
  generateEd25519Signer,
  signStatement,
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
import { verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import * as presetActivation from "./openclaw-id/member-role-presets.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.js";
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
  const memberSigner = await generateEd25519Signer();
  const peer = formatIrohEndpointKey(memberSigner.publicKey);
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
      agents: { defaults: { workspace: state.workspaceDir } },
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
          role: "viewer",
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
    const connectMember = async (memberDeviceToken?: string) => {
      const closed = createDeferredCore<number>();
      let hello: HelloOk | undefined;
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        origin: memberOrigin,
        deviceToken: memberDeviceToken,
        timeoutMs: 6000,
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        platform: "web",
        scopes: ["operator.admin"],
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
    const firstViewer = await connectMember();
    expect(firstViewer.hello?.auth.scopes).toEqual(["operator.sessions.read"]);
    const memberPairing = (await listDevicePairing()).paired.find(
      (device) => device.tokens?.operator?.token === firstViewer.hello?.auth.deviceToken,
    )!;
    expect(memberPairing.approvedScopes).toEqual(["operator.sessions.read"]);
    // The real owner RPC accepts a device signature; a member cannot sign this change.
    const changeRole = async (role: string) => {
      const { link } = await reconnect.request<{ link: { seq: number } }>("openclawId.people", {});
      const statement = await signStatement(
        "MembershipChange",
        {
          claw_id: claw.clawId,
          seq: link.seq + 1,
          target: { op: "set_role", account_id: "role-member", role },
          issued_at: Math.floor(Date.now() / 1000),
        },
        claw.device,
      );
      await reconnect.request("openclawId.authority", { action: "submit", statement });
    };
    await changeRole("guest");
    expect(await withinTest(firstViewer.closed.promise, signal)).toBe(1008);
    await firstViewer.client.stopAndWait();
    const member = await connectMember();
    expect(member.hello?.auth.scopes).toEqual(["operator.admin"]);
    expect(member.hello?.auth.roleAllowsAdmin).toBe(true);
    await member.client.request("device.pair.list", {});
    expect((await listDevicePairing()).pending).toEqual([]);
    const oldAdminToken = member.hello?.auth.deviceToken;
    expect(oldAdminToken).toBeTruthy();
    await changeRole("viewer");
    expect(await withinTest(member.closed.promise, signal)).toBe(1008);
    await member.client.stopAndWait();
    expect(
      await verifyDeviceToken({
        deviceId: memberPairing.deviceId,
        token: oldAdminToken!,
        role: "operator",
        scopes: ["operator.admin"],
      }),
    ).toMatchObject({ ok: false });
    const reassigned = await connectMember(oldAdminToken);
    expect(reassigned.hello?.auth.scopes).toEqual(["operator.sessions.read"]);
    await reassigned.client.request("sessions.list", {});
    await expect(reassigned.client.request("device.pair.list", {})).rejects.toThrow();
    await changeRole("guest");
    expect(await withinTest(reassigned.closed.promise, signal)).toBe(1008);
    await reassigned.client.stopAndWait();
    const restored = await connectMember();
    expect(restored.hello?.auth.roleAllowsAdmin).toBe(true);
    config.gateway!.roles!.definitions.guest = MEMBER_ROLE_PRESETS.viewer;
    await apply(config);
    expect(await withinTest(restored.closed.promise, signal)).toBe(4001);
    await restored.client.stopAndWait();
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
    // An independent named-role default must not cap administrator members.
    config.gateway!.roles!.default = "blocked";
    config.gateway!.roles!.definitions.blocked = {
      scopes: [],
      agents: [],
      sessions: { others: "none" },
    };
    config.gateway!.roles!.definitions.admin = {
      scopes: ["operator.admin"],
      agents: "*",
      sessions: { others: "write" },
    };
    await apply(config);
    await changeRole("admin");
    await ensureCanonicalUserProfileForEmail("another-person@example.test");
    const administrator = await connectMember();
    expect(administrator.hello?.auth.scopes).toEqual(["operator.admin"]);
    expect(administrator.hello?.auth.roleAllowsAdmin).toBe(true);
    expect.soft(administrator.hello?.auth.profileActivityViewerId).toBeUndefined();
    const self = await administrator.client.request<{ profile: { id: string } }>("users.self", {});
    expect(self.profile.id).not.toBe(GATEWAY_OWNER_PROFILE_ID);
    const profileActions = [
      ["users.listChannelIdentities", { profileId: self.profile.id }],
      ["users.background.remove", { expectedAssetId: null, expectedPreference: null }],
      ["users.channelIdentity", { action: "status", channelId: "slack" }],
      ["users.personalFile.get", { agentId: "main" }],
      ["mentions.list", {}],
      ["users.mentionable", { agentId: "main", visibility: "shared" }],
    ] as const;
    for (const [method, params] of profileActions) {
      const result = await administrator.client.request(method, params).then(
        () => "allowed",
        (error: unknown) => String(error),
      );
      expect.soft(result, method).toBe("allowed");
    }
    const { link } = await reconnect.request<{ link: { seq: number } }>("openclawId.people", {});
    const forged = await signStatement(
      "MembershipChange",
      {
        claw_id: claw.clawId,
        seq: link.seq + 1,
        target: { op: "set_role", account_id: "role-member", role: "operator" },
        issued_at: Math.floor(Date.now() / 1000),
      },
      memberSigner,
    );
    await expect(
      administrator.client.request("openclawId.authority", { action: "submit", statement: forged }),
    ).rejects.toMatchObject({ details: { code: "not_an_owner" } });
    for (const action of ["prepare", "rebind_prepare"]) {
      await expect(
        administrator.client.request("openclawId.authority", { action }),
      ).rejects.toMatchObject({ details: { code: "not_local_operator" } });
    }
    await changeRole("operator");
    expect(await withinTest(administrator.closed.promise, signal)).toBe(1008);
    await administrator.client.stopAndWait();
    const operator = await connectMember();
    expect(operator.hello?.auth.scopes).not.toContain("operator.admin");
    for (const [method, params] of profileActions) {
      if (method === "users.personalFile.get") {
        await expect(operator.client.request(method, params)).resolves.toMatchObject({
          agentId: "main",
          profileId: self.profile.id,
        });
      } else {
        await expect(operator.client.request(method, params), method).rejects.toThrow();
      }
    }
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
