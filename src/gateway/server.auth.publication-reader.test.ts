import { X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { loadDeviceIdentityIfPresent } from "../infra/device-identity.js";
import { getPairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import {
  prepareGatewayPublicationReaderV1,
  type GatewayPublicationReaderV1,
} from "../plugin-sdk/gateway-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { PUBLICATION_READ_SCOPE, PUBLICATION_STEER_SCOPE } from "./operator-scopes.js";
import { prepareGatewayPublicationTransportV1 } from "./publication-transport.js";
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
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });
describe.each([PUBLICATION_READ_SCOPE, PUBLICATION_STEER_SCOPE])(
  "restricted transport %s",
  (SCOPE) => {
    const writer = SCOPE === PUBLICATION_STEER_SCOPE;
    const READ = writer ? "session-share.steer.target" : "publication-proof.read";
    const REQUIRED_PROFILE = writer ? "session-share.steer.send" : "publication-proof.profile";
    const OTHER = writer ? "publication-proof.other" : "session-share.steer.target";
    const prepareTransport = async (request: GatewayRequestHandlerOptions) =>
      writer
        ? Promise.resolve(prepareGatewayPublicationTransportV1(request, SCOPE))
        : prepareGatewayPublicationReaderV1(request);
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
            pluginId: writer ? "session-share" : "publication-proof",
            name,
            handler,
            scope: SCOPE,
            profileAccess,
          }),
        );
      }
      registry.gatewayHandlers[OTHER] = handler;
      registry.gatewayMethodDescriptors.push(
        createPluginGatewayMethodDescriptor({
          pluginId: writer ? "session-share" : "publication-proof",
          name: OTHER,
          handler,
          scope: writer ? SCOPE : PUBLICATION_STEER_SCOPE,
          profileAccess: "independent",
        }),
      );
      setTestPluginRegistry(registry);
    }

    async function configure(withRoles: boolean) {
      await configureBrowserAuth({ mode: "token", token: "secret" }, withRoles ? { roles } : {});
    }

    test.runIf(writer)(
      "admits a signed writer over fingerprint-pinned WSS without a human",
      async ({ signal }) => {
        await configure(true);
        const stateDir = process.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("Missing isolated gateway fixture directory");
        }
        const certPath = path.join(stateDir, "writer-cert.pem");
        const keyPath = path.join(stateDir, "writer-key.pem");
        await fs.writeFile(certPath, TEST_TLS_CERT_PEM);
        await fs.writeFile(keyPath, TEST_TLS_KEY_PEM);
        const { config } = await readConfigFileSnapshot();
        await writeConfigFile({
          ...config,
          gateway: {
            ...config.gateway,
            tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          },
        });
        installMethods(async (request) => {
          const transport = await prepareTransport(request);
          transport.assertCurrent();
          expect(request.client?.authenticatedUserProfile).toBeUndefined();
          request.respond(true, { deviceId: transport.deviceId });
        });
        const device = await paired();
        const signingIdentity = loadDeviceIdentityIfPresent({ path: device.identityPath });
        if (!signingIdentity) {
          throw new Error("Missing paired fixture identity");
        }
        let hello: HelloOk | undefined;
        await withGatewayServer(async ({ port }) => {
          const client = await connectGatewayClient({
            url: `wss://127.0.0.1:${port}`,
            deviceToken: device.token,
            deviceIdentity: signingIdentity,
            tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
            clientName: BACKEND_GATEWAY_CLIENT.id,
            mode: BACKEND_GATEWAY_CLIENT.mode,
            scopes: [SCOPE],
            signal,
            onHelloOk: (value) => {
              hello = value;
            },
          });
          try {
            expect(hello?.auth).toEqual({
              method: "device-token",
              role: "operator",
              scopes: [SCOPE],
            });
            expect(hello?.features).toEqual({ methods: [READ], events: ["tick"] });
            expect(hello?.snapshot.presence).toEqual([]);
            expect(await client.request(READ)).toEqual({ deviceId: device.identity.deviceId });
            await expect(
              client.request("sessions.steerTarget", { sessionKey: "agent:main:main" }),
            ).rejects.toThrow(/denied/);
          } finally {
            await disconnectGatewayClient(client);
          }
        });
      },
    );

    test.runIf(writer)("rejects a fixed writer method owned by another plugin", async () => {
      await configure(false);
      const registry = createEmptyPluginRegistry();
      const handler = async (request: GatewayRequestHandlerOptions) => request.respond(true, {});
      registry.gatewayHandlers[READ] = handler;
      registry.gatewayMethodDescriptors.push(
        createPluginGatewayMethodDescriptor({
          pluginId: "unrelated-plugin",
          name: READ,
          handler,
          scope: SCOPE,
          profileAccess: "independent",
        }),
      );
      setTestPluginRegistry(registry);
      const device = await paired();
      await withGatewayServer(async ({ port }) => {
        const { ws, connected } = await connectReader(port, device);
        expect(connected.ok).toBe(true);
        expect((connected.payload as HelloOk).features.methods).toEqual([]);
        expect((await rpcReq(ws, READ)).error?.code).toBe("FORBIDDEN");
        ws.close();
      });
    });

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
      "sessions.steerActive",
      "sessions.steerTarget",
      OTHER,
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
          const reader = await prepareTransport(request);
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
          if (writer) {
            await expect(prepareGatewayPublicationReaderV1(captured!)).rejects.toThrow();
          }
          await expect(
            prepareTransport({ ...captured!, hasCurrentClientAuthority: () => true }),
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
      { stored: [SCOPE], requested: [writer ? PUBLICATION_READ_SCOPE : PUBLICATION_STEER_SCOPE] },
      { stored: [writer ? PUBLICATION_READ_SCOPE : PUBLICATION_STEER_SCOPE], requested: [SCOPE] },
      {
        stored: [SCOPE, writer ? PUBLICATION_READ_SCOPE : PUBLICATION_STEER_SCOPE],
        requested: [SCOPE],
      },
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
          authority = await prepareTransport(request);
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
          expect(
            (await connectReq(admin, { token: "secret", scopes: ["operator.admin"] })).ok,
          ).toBe(true);
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
              ? await rpcReq(admin, "device.pair.approve", {
                  requestId: upgrade!.request.requestId,
                })
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
            const token = (await getPairedDevice(device.identity.deviceId))!.tokens!.operator!
              .token;
            const fresh = await connectReader(port, { ...device, token });
            expect(fresh.connected.ok).toBe(true);
          }
        });
      },
    );

    test("does not expose writer operations before source handlers are registered", async () => {
      if (!writer) {
        return;
      }
      await configure(true);
      setTestPluginRegistry(createEmptyPluginRegistry());
      const device = await paired();
      await withGatewayServer(async ({ port }) => {
        const { ws, connected } = await connectReader(port, device);
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        expect((connected.payload as HelloOk).features).toEqual({ methods: [], events: ["tick"] });
        expect((await rpcReq(ws, "session-share.steer.target", {})).ok).toBe(false);
        expect((await rpcReq(ws, "session-share.steer.send", {})).ok).toBe(false);
      });
    });
  },
);
