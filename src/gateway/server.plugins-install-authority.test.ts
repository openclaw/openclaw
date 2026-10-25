import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetLogger } from "../logging/logger.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import type { GatewayClient, GatewayClientOptions } from "./client.js";
import { pairOperatorDeviceFixture } from "./paired-device.test-support.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";
import { startGatewayServerCore } from "./server-start.js";

const OLD_TOKEN = "shared-token-old";
type ConfigSnapshot = { hash: string; config: OpenClawConfig };
const wait = <T>(promise: Promise<T>, label: string) => withTestTimeout(promise, 10_000, label);

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
    await state.writeConfig({
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: OLD_TOKEN },
        controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
        reload: { mode: "hybrid" },
      },
      logging: { level: "silent", consoleLevel: "silent" },
      agents: { defaults: { workspace: state.workspaceDir } },
    });
    const startupPlugins = await import("./server-startup-plugins.js");
    const runMaintenance = startupPlugins.runGatewayPostReadyStartupMaintenance;
    const maintenanceSettled = createDeferredCore();
    const observer = vi
      .spyOn(startupPlugins, "runGatewayPostReadyStartupMaintenance")
      .mockImplementation((params) => {
        const maintenance = runMaintenance(params);
        maintenanceSettled.resolve(maintenance);
        return maintenance;
      });
    try {
      server = await startGatewayServerCore(port, { controlUiEnabled: false });
      await server.startupSettled;
      // Post-ready registry maintenance owns the lease that plugin installs refuse to wait for.
      await maintenanceSettled.promise;
    } finally {
      observer.mockRestore();
    }
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
      resetLogger,
      clearPluginMetadataLifecycleCaches,
    );
  });

  async function connect(
    options: Pick<
      GatewayClientOptions,
      "token" | "deviceToken" | "deviceIdentity" | "clientName" | "mode" | "origin"
    >,
  ) {
    const closed = createDeferredCore();
    const client = await acquireGatewayTestClient(
      {
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
        onClose: () => closed.resolve(),
      },
      {
        timeoutMs: 10_000,
        timeoutMessage: "gateway connect timeout",
        closeMessage: "closed",
      },
    );
    clients.push(client);
    return { client, closed: closed.promise };
  }

  async function openDeviceTokenClient(pluginId: string) {
    const client = { clientName: "test", mode: "test" } as const;
    const { identity, issued: rotated } = await pairOperatorDeviceFixture({
      identityPath: state.path(`${pluginId}-identity`, "client", "credentials.sqlite"),
      scopes: ["operator.admin"],
      tokenScopes: ["operator.admin"],
      clientId: client.clientName,
      clientMode: client.mode,
      callerScopes: ["operator.admin"],
    });
    expect(rotated).toMatchObject({ ok: true, entry: { token: expect.any(String) } });
    if (!rotated.ok) {
      throw new Error("expected issued device token");
    }
    const credentials = {
      ...client,
      deviceIdentity: identity,
      deviceToken: rotated.entry.token,
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
      await wait(reached.promise, "retained request did not start");
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
      expect(await wait(authority.promise, "retained authority did not settle")).toBe(false);
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
      const sourceDir = `sources/${pluginId}`;
      const source = state.statePath(sourceDir);
      await state.writeJson(`${sourceDir}/package.json`, {
        name: pluginId,
        version: "1.0.0",
        main: "index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      });
      await state.writeJson(`${sourceDir}/openclaw.plugin.json`, {
        id: pluginId,
        name: pluginId,
        activation: { onStartup: true },
        contracts: { tools: [`${pluginId.replaceAll("-", "_")}_probe`] },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      });
      await state.writeText(
        `${sourceDir}/index.cjs`,
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
        await wait(
          Promise.race([
            reached.promise,
            reply.then((response) => {
              if ("error" in response) {
                throw response.error;
              }
              throw new Error("Install replied before boundary");
            }),
            finished.promise.then(({ error }) => {
              throw error instanceof Error
                ? error
                : new Error("Install settled before boundary", { cause: error });
            }),
          ]),
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
          await wait(device.closed, "revoked socket remained open");
          await device.client.stopAndWait();
        } else if (action === "disconnect") {
          await device.client.stopAndWait();
          // A fresh connection remains possible without treating ordinary disconnect as revocation.
          await device.reconnect();
        }
        release.resolve();
        const settled = await wait(finished.promise, "install did not settle");
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
        const records = await readPersistedInstalledPluginIndexInstallRecordsAsync();
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
