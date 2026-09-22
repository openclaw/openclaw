// Real WebSocket credentials own the full staged install, ledger, and runtime transaction.
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { rotateDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { resetLogger } from "../logging/logger.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { startGatewayServerCore } from "./server-start.js";

const OLD_TOKEN = "shared-token-old";
type ConfigSnapshot = { hash: string; config: OpenClawConfig };

type Phase = "stage" | "index" | "runtime";
const observation = vi.hoisted(() => ({
  pause: async (_phase: Phase) => {},
  beforeRequest: async (_options: GatewayRequestOptions) => {},
  settled: (_error?: unknown) => {},
  indexWrites: [] as string[],
}));

// Hold existing async owner hooks; all installation, auth, storage, and activation remain real.
vi.mock("../plugins/management-mutations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/management-mutations.js")>();
  return {
    ...actual,
    installManagedPlugin: async (params: Parameters<typeof actual.installManagedPlugin>[0]) => {
      let effects = 0;
      try {
        const result = await actual.installManagedPlugin({
          ...params,
          onCapabilityConsent: async (review) => {
            await observation.pause("stage");
            return await params.onCapabilityConsent!(review);
          },
          beforePersistentEffect: async () => {
            if (++effects === 2) {
              await observation.pause("index");
            }
            await params.beforePersistentEffect?.();
          },
          applyRuntime: async (change) => {
            await observation.pause("runtime");
            return await params.applyRuntime!(change);
          },
        });
        observation.settled();
        return result;
      } catch (error) {
        observation.settled(error);
        throw error;
      }
    },
  };
});
vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    writePersistedInstalledPluginIndexInstallRecordsWithLease: (
      ...args: Parameters<typeof actual.writePersistedInstalledPluginIndexInstallRecordsWithLease>
    ) => {
      observation.indexWrites.push(
        ...Object.keys(args[0]).filter((id) => args[0][id]?.acceptedSurface),
      );
      return actual.writePersistedInstalledPluginIndexInstallRecordsWithLease(...args);
    },
  };
});

vi.mock(
  "./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("./server/ws-connection/authenticated-request-dispatch.server-methods.runtime.js")
      >();
    return {
      ...actual,
      handleGatewayRequest: async (...args: Parameters<typeof actual.handleGatewayRequest>) => {
        await observation.beforeRequest(args[0]);
        return actual.handleGatewayRequest(...args);
      },
    };
  },
);

describe("gateway plugin install authority", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let server: Awaited<ReturnType<typeof startGatewayServerCore>> | undefined;
  let port: number;
  const clients: GatewayClient[] = [];

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "plugin-install-authority",
      env: {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    port = await getFreePort();
    await startGateway();
  });

  afterEach(async () => {
    await runQaGatewayFixture(
      async () => {},
      ...clients.splice(0).map((client) => () => client.stopAndWait()),
      async () => {
        await server?.close();
        server = undefined;
      },
      () => state.cleanup(),
      () => resetLogger(),
      () => clearPluginMetadataLifecycleCaches(),
    );
  });

  async function startGateway(token: GatewayAuthConfig["token"] = OLD_TOKEN) {
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
        reload: { mode: "hybrid" },
      },
      logging: { level: "silent", consoleLevel: "silent" },
      agents: { defaults: { workspace: state.workspaceDir } },
    });
    server = await startGatewayServerCore(port, { controlUiEnabled: false });
    await server.startupSettled;
  }

  async function connect(
    options: Pick<
      GatewayClientOptions,
      "token" | "deviceToken" | "deviceIdentity" | "clientName" | "mode" | "origin"
    >,
  ) {
    const connected = createDeferredCore<HelloOk>();
    const closed = createDeferredCore<{ code: number; reason: string }>();
    const closeEvents: Array<{ code: number; reason: string }> = [];
    let hellos = 0;
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      clientName: "gateway-client",
      clientVersion: "1.0.0",
      platform: "test",
      mode: "backend",
      deviceIdentity: null,
      scopes: ["operator.admin"],
      ...options,
      // Each connection presents only its declared credential, never a cached fallback.
      hostDeps: {
        loadDeviceAuthToken: () => null,
        storeDeviceAuthToken: () => {},
        clearDeviceAuthToken: () => {},
      },
      onHelloOk: (hello) => {
        hellos += 1;
        connected.resolve(hello);
      },
      onConnectError: (error) => connected.reject(error),
      onClose: (code, reason) => {
        closeEvents.push({ code, reason });
        connected.reject(new Error(`closed ${code}: ${reason}`));
        closed.resolve({ code, reason });
      },
    });
    clients.push(client);
    client.start();
    const hello = await withTestTimeout(connected.promise, 10_000, "gateway connect timeout");
    return { client, hello, closed: closed.promise, closeEvents, hellos: () => hellos };
  }

  async function openDeviceTokenClient(pluginId: string) {
    const identity = loadOrCreateDeviceIdentity({
      path: state.path(`${pluginId}-identity.sqlite`),
    });
    const clientName = "test";
    const mode = "test";
    const pending = await requestDevicePairing({
      deviceId: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      clientId: clientName,
      clientMode: mode,
      role: "operator",
      scopes: ["operator.admin"],
    });
    await approveDevicePairing(pending.request.requestId, { callerScopes: ["operator.admin"] });
    const rotated = await rotateDeviceToken({
      deviceId: identity.deviceId,
      role: "operator",
      scopes: ["operator.admin"],
    });
    expect(rotated.ok).toBe(true);
    const issued = rotated.ok ? rotated.entry : undefined;
    expect(issued?.token).toBeTypeOf("string");
    if (!issued) {
      throw new Error("expected issued device token");
    }
    const credentials = {
      clientName,
      mode,
      deviceIdentity: identity,
      deviceToken: issued.token,
    } satisfies Parameters<typeof connect>[0];
    const connection = await connect(credentials);
    return { ...connection, deviceId: identity.deviceId, reconnect: () => connect(credentials) };
  }

  it("does not revive a disconnected request when shared auth rotates away and back", async () => {
    const requester = await connect({ token: OLD_TOKEN });
    const reached = createDeferredCore();
    const release = createDeferredCore();
    const authority = createDeferredCore<boolean | undefined>();
    observation.beforeRequest = async (options) => {
      if (options.req.method === "health") {
        reached.resolve();
        await release.promise;
        authority.resolve(options.hasCurrentClientAuthority?.());
      }
    };
    const request = requester.client.request("health").catch(() => undefined);
    try {
      await withTestTimeout(reached.promise, 10_000, "retained request did not start");
      await requester.client.stopAndWait();
      const config = structuredClone(getRuntimeConfig());
      for (const token of ["shared-token-replacement", OLD_TOKEN]) {
        // External config publication exercises the managed reload's own client iterator.
        await state.writeConfig({
          ...config,
          gateway: { ...config.gateway, auth: { mode: "token", token } },
        });
        await vi.waitFor(() => expect(getRuntimeConfig().gateway?.auth?.token).toBe(token), {
          timeout: 10_000,
        });
        const current = await connect({ token });
        await current.client.request("config.get");
      }
      release.resolve();
      expect(
        await withTestTimeout(authority.promise, 10_000, "retained authority did not settle"),
      ).toBe(false);
      await request;
    } finally {
      release.resolve();
      observation.beforeRequest = async () => {};
    }
  });

  it.each([
    { label: "authorized", phase: "stage", action: "keep" },
    { label: "reconnect", phase: "stage", action: "disconnect" },
    { label: "staged-revocation", phase: "stage", action: "revoke" },
    { label: "disconnected-revocation", phase: "stage", action: "disconnect-revoke" },
    { label: "index-revocation", phase: "index", action: "revoke" },
    { label: "runtime-revocation", phase: "runtime", action: "revoke" },
  ] as const)(
    "$label preserves the initiating authority at $phase",
    async ({ label, phase, action }) => {
      const pluginId = `authority-${label}`;
      const source = state.path(`sources/${pluginId}`);
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(
        `${source}/package.json`,
        JSON.stringify({
          name: pluginId,
          version: "1.0.0",
          main: "index.cjs",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        `${source}/openclaw.plugin.json`,
        JSON.stringify({
          id: pluginId,
          name: pluginId,
          activation: { onStartup: true },
          contracts: { tools: [`${pluginId.replaceAll("-", "_")}_probe`] },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      );
      await fs.writeFile(
        `${source}/index.cjs`,
        `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
      api.registerGatewayMethod(${JSON.stringify(`${pluginId}.probe`)}, ({respond}) => respond(true, {active: true}));
      api.registerTool({name: ${JSON.stringify(`${pluginId.replaceAll("-", "_")}_probe`)}, description: "Report readiness", parameters: {type: "object", properties: {}}, execute: async () => ({content: [{type: "text", text: "ready"}]})});
    }};`,
      );
      const admin = await connect({ token: OLD_TOKEN });
      const device = await openDeviceTokenClient(pluginId);
      const before = await admin.client.request<ConfigSnapshot>("config.get");
      const reached = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore<{ error?: unknown }>();
      observation.indexWrites = [];
      observation.pause = async (current) => {
        if (current === phase) {
          reached.resolve();
          await release.promise;
        }
      };
      observation.settled = (error) => finished.resolve({ error });
      const request = device.client.request("plugins.install", { source: "local", path: source });
      // A revoked/disconnected socket loses its reply; the actual mutation still must settle safely.
      const reply = request.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
      try {
        await withTestTimeout(
          Promise.race([
            reached.promise,
            finished.promise.then(({ error }) => {
              throw error instanceof Error
                ? error
                : new Error("Install settled before boundary", { cause: error });
            }),
          ]),
          10_000,
          "install boundary not reached",
        );
        if (action === "disconnect-revoke") {
          await device.client.stopAndWait();
        }
        if (action === "revoke" || action === "disconnect-revoke") {
          await admin.client.request("device.token.revoke", {
            deviceId: device.deviceId,
            role: "operator",
          });
          await withTestTimeout(device.closed, 10_000, "revoked socket remained open");
          await device.client.stopAndWait();
        } else if (action === "disconnect") {
          await device.client.stopAndWait();
          // A fresh connection remains possible without treating ordinary disconnect as revocation.
          await device.reconnect();
        }
        release.resolve();
        const settled = await withTestTimeout(finished.promise, 10_000, "install did not settle");
        const response = await reply;
        if (action === "keep") {
          expect(response).toMatchObject({
            result: {
              ok: true,
              restartRequired: false,
              runtime: { generation: expect.any(Number) },
            },
          });
        }
        const records = readPersistedInstalledPluginIndexInstallRecords();
        const after = await admin.client.request<ConfigSnapshot>("config.get");
        const revoked = action === "revoke" || action === "disconnect-revoke";
        const committed = !revoked || phase === "runtime";
        expect(Boolean(records?.[pluginId]?.acceptedSurface)).toBe(committed);
        expect(Boolean(after.config.plugins?.entries?.[pluginId]?.enabled)).toBe(committed);
        const persisted = JSON.parse(await fs.readFile(state.configPath, "utf8")) as OpenClawConfig;
        expect(persisted.plugins?.entries?.[pluginId]).toEqual(
          committed ? { enabled: true } : undefined,
        );
        if (revoked) {
          expect(settled.error).toBeDefined();
          if (phase !== "runtime") {
            expect(observation.indexWrites).not.toContain(pluginId);
            expect(after.hash).toBe(before.hash);
            await expect(fs.stat(state.path(`extensions/${pluginId}`))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
          await expect(admin.client.request(`${pluginId}.probe`)).rejects.toThrow();
        } else {
          expect(settled.error).toBeUndefined();
          await expect(admin.client.request(`${pluginId}.probe`)).resolves.toEqual({
            active: true,
          });
        }
      } finally {
        release.resolve();
        observation.pause = async () => {};
      }
    },
  );
});
