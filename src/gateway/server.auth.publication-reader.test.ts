import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import {
  prepareGatewayPublicationReaderV1,
  type GatewayPublicationReaderV1,
} from "../plugin-sdk/gateway-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { PUBLICATION_READ_SCOPE } from "./operator-scopes.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { seedApprovedOperatorReadPairing } from "./server.auth.control-ui.fixtures.test-support.js";
import {
  BACKEND_GATEWAY_CLIENT,
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });
const SCOPE = PUBLICATION_READ_SCOPE;
const READ = "publication-proof.read";
const REQUIRED_PROFILE = "publication-proof.profile";
const roles = {
  default: "member",
  definitions: {
    member: {
      scopes: ["operator.read" as const],
      sessions: { others: "none" as const },
      agents: [],
    },
  },
};

async function paired(scopes = [SCOPE] as string[]) {
  const seeded = await seedApprovedOperatorReadPairing({
    identityPrefix: "publication-reader-",
    clientId: BACKEND_GATEWAY_CLIENT.id,
    clientMode: BACKEND_GATEWAY_CLIENT.mode,
    displayName: "reader",
    platform: "node",
    scopes,
  });
  const token = (await getPairedDevice(seeded.identity.deviceId))?.tokens?.operator?.token;
  expect(token).toBeTruthy();
  return { ...seeded, token: token! };
}

async function connectReader(
  port: number,
  device: Awaited<ReturnType<typeof paired>>,
  scopes = [SCOPE] as string[],
) {
  const ws = await openWs(port);
  const connected = await connectReq(ws, {
    client: BACKEND_GATEWAY_CLIENT,
    deviceToken: device.token,
    deviceIdentityPath: device.identityPath,
    scopes,
    skipDefaultAuth: true,
  });
  return { ws, connected };
}

function installMethods(handler: GatewayRequestHandler) {
  const registry = createEmptyPluginRegistry();
  for (const [name, profileAccess] of [
    [READ, "independent"],
    [REQUIRED_PROFILE, "required"],
  ] as const) {
    registry.gatewayHandlers[name] = handler;
    registry.gatewayMethodDescriptors.push(
      createPluginGatewayMethodDescriptor({
        pluginId: "publication-proof",
        name,
        handler,
        scope: SCOPE,
        profileAccess,
      }),
    );
  }
  setTestPluginRegistry(registry);
}

async function configure(withRoles: boolean) {
  await configureBrowserAuth({ mode: "token", token: "secret" }, withRoles ? { roles } : {});
}

const denyMethods = [
  "health",
  "chat.metadata",
  "chat.history",
  "users.prefs.get",
  "users.prefs.set",
  "users.personalFile.get",
  "sessions.setInvolvement",
  "sessions.list",
  "sessions.send",
  "device.scopes.requestUpgrade",
  "device.scopes.waitUpgrade",
  "device.token.rotate",
  "config.get",
  REQUIRED_PROFILE,
];

test.each([false, true])(
  "signed singleton reader is device-only and closed with roles=%s",
  async (withRoles) => {
    await configure(withRoles);
    let captured: GatewayRequestHandlerOptions | undefined;
    installMethods(async (request) => {
      captured = request;
      const reader = await prepareGatewayPublicationReaderV1(request);
      reader.assertCurrent();
      request.respond(true, { deviceId: reader.deviceId });
    });
    const device = await paired();
    await withGatewayServer(async ({ port }) => {
      const { ws, connected } = await connectReader(port, device);
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      const hello = connected.payload as HelloOk;
      expect(hello.auth).toEqual({ method: "device-token", role: "operator", scopes: [SCOPE] });
      expect(hello.features).toEqual({ methods: [READ], events: ["tick"] });
      expect(hello.snapshot).toEqual({
        presence: [],
        health: {},
        stateVersion: { presence: 0, health: 0 },
        uptimeMs: 0,
      });
      expect(Object.keys(hello).toSorted()).toEqual([
        "auth",
        "features",
        "policy",
        "protocol",
        "server",
        "snapshot",
        "type",
      ]);
      expect(Object.keys(hello.policy).toSorted()).toEqual([
        "maxBufferedBytes",
        "maxPayload",
        "tickIntervalMs",
      ]);
      expect((await rpcReq(ws, READ)).payload).toEqual({ deviceId: device.identity.deviceId });
      expect(captured?.client?.authenticatedUserProfile).toBeUndefined();
      expect(captured?.client?.authenticatedUserId).toBeUndefined();
      expect(captured?.client?.internal?.operatorRoleActor).toBeUndefined();
      expect(captured?.client?.presenceKey).toBeUndefined();
      for (const method of denyMethods) {
        expect(
          captured?.context.getGatewayMethodRegistry?.().getDescriptor(method),
          method,
        ).toBeDefined();
        const denied = await rpcReq(ws, method, {});
        expect(denied.ok, method).toBe(false);
        expect(denied.error?.code, method).toBe("FORBIDDEN");
      }
      expect(captured).toBeDefined();
      await expect(
        prepareGatewayPublicationReaderV1({ ...captured!, hasCurrentClientAuthority: () => true }),
      ).rejects.toThrow();
      const events: string[] = [];
      const observe = (raw: WebSocket.RawData) => {
        const value = JSON.parse(rawDataToString(raw));
        if (value.type === "event") {
          events.push(value.event);
        }
      };
      ws.on("message", observe);
      for (const name of [
        "health",
        "heartbeat",
        "presence",
        "sessions.changed",
        "plugin.secret",
        "tick",
      ]) {
        captured!.context.broadcast(name, { private: "must-not-leak" });
      }
      captured!.context.broadcast("tick", { ts: 42 });
      // Round trip orders the outbound frames without a timing sleep.
      await rpcReq(ws, READ);
      ws.off("message", observe);
      expect(events).toEqual(["tick"]);
    });
  },
);

test.each([
  { stored: ["operator.admin"], requested: [SCOPE] },
  { stored: [SCOPE, "operator.read"], requested: [SCOPE] },
  { stored: [SCOPE], requested: [] },
  { stored: [SCOPE], requested: [SCOPE, "operator.read"] },
])("rejects non-singleton admission $stored -> $requested", async ({ stored, requested }) => {
  await configure(false);
  const device = await paired(stored);
  await withGatewayServer(async ({ port }) => {
    const { connected } = await connectReader(port, device, requested);
    expect(connected.ok).toBe(false);
  });
});

test("shared auth and unsigned requests cannot claim publication-reader admission", async () => {
  await configure(false);
  await withGatewayServer(async ({ port }) => {
    for (const unsigned of [false, true]) {
      const ws = await openWs(port);
      const connected = await connectReq(ws, {
        token: "secret",
        scopes: [SCOPE],
        ...(unsigned ? { device: null } : {}),
      });
      expect(connected.ok).toBe(false);
    }
    const ws = await openWs(port);
    const normal = await connectReq(ws, { token: "secret", scopes: ["operator.admin"] });
    expect(normal.ok).toBe(true);
    expect((normal.payload as HelloOk).features.methods).toContain("config.get");
  });
});

test.each(
  (["rotate", "revoke", "approve"] as const).flatMap((operation) =>
    [true, false].map((checkSdk) => ({ operation, checkSdk })),
  ),
)(
  "$operation fences late responses (post-mutation SDK check: $checkSdk)",
  async ({ operation, checkSdk }) => {
    await configure(true);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const completed = createDeferredCore<boolean>();
    let authority: GatewayPublicationReaderV1 | undefined;
    installMethods(async (request) => {
      authority = await prepareGatewayPublicationReaderV1(request);
      entered.resolve();
      await release.promise;
      if (checkSdk) {
        try {
          authority.assertCurrent();
          completed.resolve(true);
        } catch {
          completed.resolve(false);
        }
      } else {
        // Exercise the dispatcher alone: neither handler nor test refreshes authority.
        completed.resolve(false);
      }
      // The host must suppress a stale success even if a plugin fails to recheck.
      request.respond(true, { private: "must-not-leak" });
    });
    const device = await paired();
    await withGatewayServer(async ({ port }) => {
      const reader = await connectReader(port, device);
      expect(reader.connected.ok).toBe(true);
      const pending = rpcReq(reader.ws, READ).catch(() => undefined);
      await entered.promise;
      const admin = await openWs(port);
      expect((await connectReq(admin, { token: "secret", scopes: ["operator.admin"] })).ok).toBe(
        true,
      );
      const upgrade =
        operation === "approve"
          ? await requestDevicePairing({
              deviceId: device.identity.deviceId,
              publicKey: (await getPairedDevice(device.identity.deviceId))!.publicKey,
              role: "operator",
              scopes: [SCOPE, "operator.read"],
            })
          : undefined;
      const changed =
        operation === "approve"
          ? await rpcReq(admin, "device.pair.approve", { requestId: upgrade!.request.requestId })
          : await rpcReq(admin, `device.token.${operation}`, {
              deviceId: device.identity.deviceId,
              role: "operator",
              ...(operation === "rotate" ? { scopes: [SCOPE] } : {}),
            });
      expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
      if (checkSdk) {
        expect(() => authority!.assertCurrent()).toThrow();
      }
      release.resolve();
      expect(await completed.promise).toBe(false);
      expect(await waitForWsClose(reader.ws, 2_000)).toBe(true);
      expect(await pending).toBeUndefined();
      const stale = await connectReader(port, device);
      expect(stale.connected.ok).toBe(false);
      if (operation === "rotate") {
        const token = (await getPairedDevice(device.identity.deviceId))!.tokens!.operator!.token;
        const fresh = await connectReader(port, { ...device, token });
        expect(fresh.connected.ok).toBe(true);
      }
    });
  },
);
