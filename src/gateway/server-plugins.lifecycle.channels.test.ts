/** Real Gateway channel ownership across plugin replacement and failed cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import * as configFileSource from "../config/source-file.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createWatcherMock } from "./config-reload.watcher.test-support.js";
import {
  INSTANCE_BINDING_PROBE_METHOD,
  installInstanceBindingProbeCoordinator,
  type InstanceBindingProbeResult,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  closePluginGateway,
  configurePluginGateway,
  observePostReadyStartupMaintenance,
  startPluginGateway,
  reloadPlugin,
  writeJson,
  type PluginServer,
  type PluginSocket,
} from "./server-plugins.lifecycle.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { connectWebchatClient, installGatewayTestHooks, rpcReq } from "./test-helpers.server.js";

// Fixtures must register real plugins after the shared helpers install their mocks.
vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

async function useGatewayGraphPluginRuntime(): Promise<void> {
  // Keep the real lazy runtime on this server fixture's mocked Vitest graph.
  const runtimeModule = await import("../plugins/runtime/index.js");
  const nativeModule = await import("../plugins/native-module-require.js");
  const nativeLoad = nativeModule.tryNativeRequireModule;
  const runtimePaths = new Set([
    path.resolve("src/plugins/runtime/index.ts"),
    path.resolve("dist/plugins/runtime/index.js"),
  ]);
  const runtimeLoader = vi
    .spyOn(nativeModule, "tryNativeRequireModule")
    .mockImplementation((modulePath, options) =>
      runtimePaths.has(modulePath)
        ? { ok: true, moduleExport: runtimeModule }
        : nativeLoad(modulePath, options),
    );
  onTestFinished(() => runtimeLoader.mockRestore());
}

function enabledPlugins(ids: string[], previous: OpenClawConfig["plugins"] = {}) {
  return {
    ...previous,
    enabled: true,
    allow: ids,
    entries: {
      ...previous.entries,
      ...Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
    },
  };
}

const channelId = "reload-webhook";
let server: PluginServer | undefined;
let socket: PluginSocket | undefined;
let releasePending = createDeferredCore();

afterEach(async () => {
  releasePending.resolve();
  try {
    await closePluginGateway(server, socket);
  } finally {
    server = undefined;
    socket = undefined;
  }
});

it(
  "hot-applies pending installs without restarting a sibling whose package metadata keys were reordered",
  { timeout: 120_000 },
  async () => {
    const bundledRoot = tempDirs.make("openclaw-cold-channel-");
    for (const channel of ["cold-chat", "sibling-chat"]) {
      const id = `${channel}-owner`;
      const pluginDir = path.join(bundledRoot, id);
      await fs.mkdir(pluginDir, { recursive: true });
      await writeJson(path.join(pluginDir, "package.json"), {
        name: id,
        type: "commonjs",
        main: "index.js",
        openclaw: { extensions: ["./index.js"], runtimeExtensions: ["./index.js"] },
        peerDependencies: { openclaw: ">=2026.1.1" },
      });
      await writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
        id,
        channels: [channel],
        activation: { onStartup: true },
        channelConfigs: {
          [channel]: {
            schema: {
              type: "object",
              additionalProperties: false,
              properties: { enabled: { type: "boolean" }, label: { type: "string" } },
            },
          },
        },
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      });
      await fs.writeFile(
        path.join(pluginDir, "index.js"),
        `
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  const instance = require("node:crypto").randomUUID();
  const channel = ${JSON.stringify(channel)};
  const captured = api.config.channels?.[channel] ?? null;
  let starts = 0, stops = 0;
  api.registerGatewayMethod(channel + ".probe", ({ context, respond }) => {
    respond(true, { instance, captured, starts, stops, pid: process.pid, reloadSettled: context.isConfigReloadSettled() });
  }, { scope: "operator.read" });
  if (!captured?.enabled) return;
  api.registerChannel({ id: channel,
    meta: { id: channel, label: channel, selectionLabel: channel, docsPath: "/channels", blurb: "Synthetic setup channel" },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({ accountId: "default", enabled: true }), isConfigured: () => true },
    gateway: { async startAccount({ abortSignal, setStatus }) {
      starts++;
      setStatus({ accountId: "default", running: true, connected: true, lifecycle: "ready" });
      await new Promise((resolve) => {
        if (abortSignal.aborted) { resolve(); return; }
        abortSignal.addEventListener("abort", resolve, { once: true });
      });
      stops++;
    } },
  });
} };`,
      );
    }
    const configPath = configurePluginGateway(bundledRoot, true);
    const config = loadGatewayTestConfig();
    config.plugins = enabledPlugins(["cold-chat-owner", "sibling-chat-owner"], {
      slots: { memory: "none" },
    });
    config.channels = { "sibling-chat": { enabled: true, label: "retained" } };
    await writeJson(configPath, config);
    const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
    await useGatewayGraphPluginRuntime();
    const createConfigFileAdapter = configFileSource.createConfigFileAdapter;
    let configWatcher: ReturnType<typeof createWatcherMock> | undefined;
    const watchSpy = vi
      .spyOn(configFileSource, "createConfigFileAdapter")
      .mockImplementation((options) => {
        if (options.path !== configPath) {
          return createConfigFileAdapter(options);
        }
        // Explicit writes own reloads; inject the filesystem echo at its race boundary below.
        const watcher = createWatcherMock();
        configWatcher = watcher;
        const adapter = watcher.attach(options);
        return {
          ...adapter,
          async start() {
            await adapter.start();
            queueMicrotask(() => watcher.emit("ready"));
          },
        };
      });
    onTestFinished(() => watchSpy.mockRestore());
    const started = await startPluginGateway({ hotReloadRecovery });
    server = started.server;
    await server.startupSettled;
    await waitForGatewayStartup(started.port);
    socket = await connectWebchatClient({ port: started.port, scopes: ["operator.admin"] });
    const connected = socket;
    type Probe = {
      instance: string;
      captured: { enabled: boolean; label: string } | null;
      starts: number;
      stops: number;
      pid: number;
      reloadSettled: boolean;
    };
    // Registration precedes watcher settlement; poll only the read, never the mutation.
    const settledProbe = (channel: string) =>
      vi.waitUntil(async () => {
        const result = await rpcReq<Probe>(connected, `${channel}.probe`, {});
        expect(result.ok, result.error?.message).toBe(true);
        assert.ok(result.payload);
        const { reloadSettled, ...binding } = result.payload;
        return reloadSettled ? binding : false;
      });
    await expect.poll(async () => (await settledProbe("sibling-chat")).starts).toBe(1);
    const sibling = await settledProbe("sibling-chat");
    const cold = await settledProbe("cold-chat");
    expect(cold).toMatchObject({ captured: null, starts: 0, stops: 0, pid: process.pid });
    for (const label of ["first setup", "edited setup"]) {
      const current = await rpcReq<{ hash: string }>(connected, "config.get", {});
      const changed = await rpcReq(connected, "config.patch", {
        raw: JSON.stringify({ channels: { "cold-chat": { enabled: true, label } } }),
        baseHash: current.payload?.hash,
      });
      expect(changed.ok, changed.error?.message).toBe(true);
      expect(changed.payload).toMatchObject({
        sentinel: { payload: { stats: { requiresRestart: false } } },
      });
      await expect.poll(async () => (await settledProbe("cold-chat")).captured?.label).toBe(label);
      const replacement = await settledProbe("cold-chat");
      expect(replacement).toMatchObject({ starts: 1, stops: 0, pid: cold.pid });
      expect(replacement.instance).not.toBe(cold.instance);
      expect(await settledProbe("sibling-chat")).toEqual(sibling);
    }
    // Installing another plugin can rebuild metadata through a different producer.
    // Reordering an unchanged sibling's package keys must not stop its live account.
    const siblingPackagePath = path.join(bundledRoot, "sibling-chat-owner", "package.json");
    const siblingPackage = JSON.parse(await fs.readFile(siblingPackagePath, "utf8"));
    siblingPackage.openclaw = { runtimeExtensions: ["./index.js"], extensions: ["./index.js"] };
    await writeJson(siblingPackagePath, siblingPackage);
    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    persisted.channels["cold-chat"] = { enabled: true, label: "installed setup" };
    const installPath = path.join(bundledRoot, "cold-chat-owner");
    persisted.plugins.installs = {
      "cold-chat-owner": { source: "path", sourcePath: installPath, installPath },
    };
    const application = createRuntimeConfigWriteApplication();
    const committed = await commitConfigWithPendingPluginInstalls({
      writeOptions: attachRuntimeConfigWriteApplication({}, application),
      nextConfig: persisted,
    });
    expect(committed.afterWrite.mode).toBe("auto");
    expect(application.claimed).toBe(true);
    // Persistence schedules application; await its owner before probing the replacement.
    await expect(application.result).resolves.toBe("applied");
    expect((await settledProbe("cold-chat")).captured?.label).toBe("installed setup");
    expect(await settledProbe("cold-chat")).toMatchObject({ starts: 1, stops: 0, pid: cold.pid });
    expect(await settledProbe("sibling-chat")).toEqual(sibling);
    assert.ok(configWatcher);
    const watcher = configWatcher;
    const metadataModule = await import("../config/io.plugin-metadata.js");
    const resolveMetadata = metadataModule.resolveConfigWidePluginMetadataSnapshotAsync;
    let echoed = false;
    const metadataSpy = vi
      .spyOn(metadataModule, "resolveConfigWidePluginMetadataSnapshotAsync")
      .mockImplementation(async (params) => {
        const metadata = await resolveMetadata(params);
        if (!echoed && params.allowCurrent === false) {
          echoed = true;
          // The config write can echo while explicit reload prepares its metadata.
          watcher.emit("change", configPath);
        }
        return metadata;
      });
    onTestFinished(() => metadataSpy.mockRestore());
    const explicit = await reloadPlugin(connected, "cold-chat-owner");
    expect(echoed).toBe(true);
    expect(explicit.ok, explicit.error?.message).toBe(true);
    expect(await settledProbe("sibling-chat")).toEqual(sibling);
    expect(connected.readyState).toBe(connected.OPEN);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "hands off webhook accounts while preserving manual stops (cleanup rejects=%s)",
  { timeout: 120_000 },
  async (teardownFails) => {
    releasePending = createDeferredCore();
    const starts = new Map<string, number>();
    const handledRequests = new Map<string, number>();
    const channelPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channelId,
        config: {
          listAccountIds: () => ["active", "pending", "parked"],
          defaultAccountId: () => "pending",
          inspectAccount: (_cfg, accountId) => ({
            accountId: `${accountId}-display`,
            enabled: true,
            configured: true,
          }),
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
      }),
      gateway: {
        async startAccount({ accountId, abortSignal, setStatus }) {
          const generation = (starts.get(accountId) ?? 0) + 1;
          starts.set(accountId, generation);
          const aborted = new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (accountId === "pending" && generation === 1) {
            await Promise.race([releasePending.promise, aborted]);
          }
          if (abortSignal.aborted) {
            return;
          }
          const unregister = registerPluginHttpRoute({
            path: `/reload-webhook/${accountId}`,
            auth: "plugin",
            pluginId: "instance-binding-probe",
            accountId,
            throwOnFailure: true,
            handler: (_req, res) => {
              handledRequests.set(accountId, (handledRequests.get(accountId) ?? 0) + 1);
              const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
              res.setHeader(
                "x-webhook-registry",
                registry === getActivePluginRegistry() ? "current" : "stale",
              );
              res.end(`${accountId}:${generation}`);
            },
          });
          setStatus({ accountId, running: true, connected: true, lifecycle: "ready" });
          try {
            await aborted;
          } finally {
            unregister();
          }
        },
      },
    };
    const coordinator = installInstanceBindingProbeCoordinator(
      teardownFails ? { serviceStopFailure: "rejection" } : undefined,
    );
    coordinator.channel = channelPlugin;
    const pluginRoot = tempDirs.make("openclaw-instance-binding-");
    await writeInstanceBindingProbePlugin(pluginRoot, coordinator.channelName, channelId);
    const configPath = configurePluginGateway(tempDirs.make("openclaw-bundled-empty-"), true);
    const config = loadGatewayTestConfig();
    config.plugins = {
      ...enabledPlugins(["instance-binding-probe"], config.plugins),
      load: { paths: [pluginRoot] },
    };
    await writeJson(configPath, config);
    const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
    await useGatewayGraphPluginRuntime();
    const maintenance = await observePostReadyStartupMaintenance();
    const started = await startPluginGateway({ hotReloadRecovery });
    server = started.server;
    const port = started.port;
    await server.startupSettled;
    await waitForGatewayStartup(port);
    await maintenance.settled;
    const probe = async (accountId: string) => {
      const before = handledRequests.get(accountId) ?? 0;
      let phase = "fetch";
      try {
        const response = await fetch(`http://127.0.0.1:${port}/reload-webhook/${accountId}`, {
          method: "POST",
        });
        phase = "body";
        return {
          status: response.status,
          body: await response.text(),
          registry: response.headers.get("x-webhook-registry"),
        };
      } catch (error) {
        process.stderr.write(
          `[plugin-webhook-probe] ${JSON.stringify({
            accountId,
            phase,
            starts: [...starts],
            handlerEntered: (handledRequests.get(accountId) ?? 0) > before,
          })}\n`,
        );
        throw error;
      }
    };
    await expect
      .poll(() => [...starts.keys()].toSorted(), { timeout: 30_000 })
      .toEqual(["active", "parked", "pending"]);
    expect(await probe("active")).toEqual({ status: 200, body: "active:1", registry: "current" });
    expect((await probe("pending")).status).toBe(404);
    socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
    const connected = socket;
    const stopped = await rpcReq(connected, "channels.stop", {
      channel: channelId,
      accountId: "parked",
    });
    expect(stopped.ok, stopped.error?.message).toBe(true);
    expect((await probe("parked")).status).toBe(404);

    await vi.waitUntil(
      async () => {
        const settlement = await rpcReq<InstanceBindingProbeResult>(
          connected,
          INSTANCE_BINDING_PROBE_METHOD,
          {},
        );
        expect(settlement.ok, settlement.error?.message).toBe(true);
        return settlement.payload?.reloadSettled === true;
      },
      { timeout: 30_000 },
    );
    const initialRegistry = getActivePluginRegistry();
    const reload = await reloadPlugin(socket);
    if (teardownFails) {
      expect(reload).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "drain" } } },
      });
      expect(reload.error?.message).toContain("instance-binding service cleanup rejected");
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      releasePending.resolve();
      for (const accountId of ["active", "pending", "parked"]) {
        expect((await probe(accountId)).status).toBe(accountId === "active" ? 503 : 404);
        expect(starts.get(accountId)).toBe(1);
      }
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      return;
    }
    expect(reload, reload.error?.message).toMatchObject({
      ok: true,
      payload: {
        ok: true,
        restartRequired: false,
        runtime: { pluginIds: ["instance-binding-probe"] },
      },
    });
    await expect
      .poll(() => getActivePluginRegistry() !== initialRegistry, { timeout: 180_000 })
      .toBe(true);
    await expect
      .poll(() => probe("active"), { timeout: 30_000 })
      .toEqual({ status: 200, body: "active:2", registry: "current" });
    await expect
      .poll(() => probe("pending"), { timeout: 30_000 })
      .toEqual({ status: 200, body: "pending:2", registry: "current" });
    releasePending.resolve();
    expect(await probe("pending")).toEqual({ status: 200, body: "pending:2", registry: "current" });
    expect((await probe("parked")).status).toBe(404);
    expect(starts.get("parked")).toBe(1);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  },
);
