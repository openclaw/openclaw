/** Real Gateway channel ownership across plugin replacement and failed cleanup. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { commitConfigWithPendingPluginInstalls } from "../plugins/install-record-commit.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  clearInstanceBindingProbeCoordinators,
  installInstanceBindingProbeCoordinator,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import {
  installInstanceBindingConfigIo,
  requireBoundRuntime,
  requestSettledInstanceBindingProbe,
} from "./server-plugins.lifecycle.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Fixtures must register real plugins after the shared helpers install their mocks.
vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

// A real plugin registry replacement must own accounts before their first route exists.
describe("Gateway plugin replacement channel ownership", () => {
  const channelId = "reload-webhook";
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
  let releasePending = createDeferredCore();

  afterEach(async () => {
    releasePending.resolve();
    const closingSocket = socket;
    const socketClosed =
      !closingSocket || closingSocket.readyState === closingSocket.CLOSED
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            closingSocket.once("close", () => resolve());
          });
    closingSocket?.close();
    try {
      const results = await Promise.allSettled([
        server?.close({ reason: "webhook reload cleanup" }),
        socketClosed,
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Webhook lifecycle fixture shutdown failed");
      }
    } finally {
      clearInstanceBindingProbeCoordinators();
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
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
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({
            name: id,
            type: "commonjs",
            main: "index.js",
            openclaw: { extensions: ["./index.js"], runtimeExtensions: ["./index.js"] },
            peerDependencies: { openclaw: ">=2026.1.1" },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
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
          }),
        );
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
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      delete process.env.OPENCLAW_SKIP_CHANNELS;
      delete process.env.OPENCLAW_SKIP_PROVIDERS;
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("Gateway fixture did not set config path");
      }
      const config = loadGatewayTestConfig();
      config.plugins = {
        enabled: true,
        allow: ["cold-chat-owner", "sibling-chat-owner"],
        slots: { memory: "none" },
        entries: {
          "cold-chat-owner": { enabled: true },
          "sibling-chat-owner": { enabled: true },
        },
      };
      config.channels = { "sibling-chat": { enabled: true, label: "retained" } };
      await fs.writeFile(configPath, JSON.stringify(config));
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const runtimeModule = await import("../plugins/runtime/index.js");
      const loaderModule = await import("../plugins/loader-module-runtime.js");
      const createLazyRuntime = loaderModule.createLazyPluginRuntime;
      const runtimeLoader = vi
        .spyOn(loaderModule, "createLazyPluginRuntime")
        .mockImplementation((params) =>
          createLazyRuntime({ ...params, loadPluginModule: () => runtimeModule }),
        );
      onTestFinished(() => runtimeLoader.mockRestore());
      const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
      const port = portClaim.port;
      server = await startTestGatewayServer(portClaim, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
        hotReloadRecovery,
      });
      await server.startupSettled;
      socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      const connected = socket;
      type Probe = {
        instance: string;
        captured: { enabled: boolean; label: string } | null;
        starts: number;
        stops: number;
        pid: number;
        reloadSettled: boolean;
      };
      const probe = async (channel: string) => {
        const result = await rpcReq<Probe>(connected, `${channel}.probe`, {});
        expect(result.ok, result.error?.message).toBe(true);
        assert.ok(result.payload);
        // Registration is visible before the watcher releases its lifecycle lease.
        // Wait for the owner's settlement signal, not a retry of a mutating RPC.
        const { reloadSettled, ...binding } = result.payload;
        return { binding, reloadSettled };
      };
      const settledProbe = async (channel: string) =>
        await vi.waitUntil(async () => {
          const result = await probe(channel);
          return result.reloadSettled ? result.binding : false;
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
        await expect
          .poll(async () => (await settledProbe("cold-chat")).captured?.label)
          .toBe(label);
        expect(await settledProbe("cold-chat")).toMatchObject({
          starts: 1,
          stops: 0,
          pid: cold.pid,
        });
        expect((await settledProbe("cold-chat")).instance).not.toBe(cold.instance);
        expect(await settledProbe("sibling-chat")).toEqual(sibling);
      }
      // Installing another plugin can rebuild metadata through a different producer.
      // Reordering an unchanged sibling's package keys must not stop its live account.
      const siblingPackagePath = path.join(bundledRoot, "sibling-chat-owner", "package.json");
      const siblingPackage = JSON.parse(await fs.readFile(siblingPackagePath, "utf8"));
      await fs.writeFile(
        siblingPackagePath,
        JSON.stringify({
          ...siblingPackage,
          openclaw: { runtimeExtensions: ["./index.js"], extensions: ["./index.js"] },
        }),
      );
      const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
      const committed = await commitConfigWithPendingPluginInstalls({
        nextConfig: {
          ...persisted,
          channels: {
            ...persisted.channels,
            "cold-chat": { enabled: true, label: "installed setup" },
          },
          plugins: {
            ...persisted.plugins,
            installs: {
              "cold-chat-owner": {
                source: "path",
                sourcePath: path.join(bundledRoot, "cold-chat-owner"),
                installPath: path.join(bundledRoot, "cold-chat-owner"),
              },
            },
          },
        },
      });
      expect(committed.afterWrite.mode).toBe("auto");
      await expect
        .poll(async () => (await settledProbe("cold-chat")).captured?.label)
        .toBe("installed setup");
      expect(await settledProbe("cold-chat")).toMatchObject({ starts: 1, stops: 0, pid: cold.pid });
      expect(await settledProbe("sibling-chat")).toEqual(sibling);
      const explicit = await rpcReq(connected, "plugins.reload", {
        plugins: [{ pluginId: "cold-chat-owner" }],
      });
      expect(explicit.ok, explicit.error?.message).toBe(true);
      expect(await settledProbe("sibling-chat")).toEqual(sibling);
      expect(connected.readyState).toBe(connected.OPEN);
      expect(hotReloadRecovery).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "hands off live and pending webhook accounts while preserving a manual stop",
      teardownFails: false,
    },
    {
      name: "refuses webhook account replacement when service cleanup rejects",
      teardownFails: true,
    },
  ])("$name", { timeout: 120_000 }, async ({ teardownFails }) => {
    releasePending = createDeferredCore();
    const starts = new Map<string, number>();
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
    const bundledRoot = tempDirs.make("openclaw-instance-binding-");
    await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName, channelId);
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Gateway fixture did not set config path");
    }
    const config = loadGatewayTestConfig();
    config.plugins = {
      ...config.plugins,
      enabled: true,
      allow: ["instance-binding-probe"],
      entries: {
        ...config.plugins?.entries,
        "instance-binding-probe": { enabled: true },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const hotReloadRecovery = vi.fn(() => ({
      status: "emitted" as const,
    }));
    // Use the real runtime in Vitest's graph; native loading evaluates its mocked graph again.
    const runtimeModule = await import("../plugins/runtime/index.js");
    const loaderModule = await import("../plugins/loader-module-runtime.js");
    const createLazyRuntime = loaderModule.createLazyPluginRuntime;
    const runtimeLoader = vi
      .spyOn(loaderModule, "createLazyPluginRuntime")
      .mockImplementation((params) =>
        createLazyRuntime({ ...params, loadPluginModule: () => runtimeModule }),
      );
    onTestFinished(() => runtimeLoader.mockRestore());
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const port = portClaim.port;
    server = await startTestGatewayServer(portClaim, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      sidecarStartup: "start",
      hotReloadRecovery,
    });
    await server.startupSettled;
    const probe = async (accountId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/reload-webhook/${accountId}`, {
        method: "POST",
      });
      return {
        status: response.status,
        body: await response.text(),
        registry: response.headers.get("x-webhook-registry"),
      };
    };
    await expect
      .poll(() => [...starts.keys()].toSorted(), { timeout: 30_000 })
      .toEqual(["active", "parked", "pending"]);
    expect(await probe("active")).toEqual({
      status: 200,
      body: "active:1",
      registry: "current",
    });
    expect((await probe("pending")).status).toBe(404);
    socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
    const stopped = await rpcReq(socket, "channels.stop", {
      channel: channelId,
      accountId: "parked",
    });
    expect(stopped.ok, stopped.error?.message).toBe(true);
    expect((await probe("parked")).status).toBe(404);

    const { runtime } = await requireBoundRuntime(coordinator.runtimes, "webhook channel reload");
    await requestSettledInstanceBindingProbe(runtime);
    const initialRegistry = getActivePluginRegistry();
    const reload = await rpcReq(socket, "plugins.reload", {
      plugins: [{ pluginId: "instance-binding-probe" }],
    });
    if (teardownFails) {
      expect(reload).toMatchObject({
        ok: false,
        error: { details: { runtime: { committed: false, phase: "drain" } } },
      });
      expect(reload.error?.message).toContain("instance-binding service cleanup rejected");
      expect(coordinator.serviceStops).toBe(1);
      expect(coordinator.serviceStarts).toBe(1);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      releasePending.resolve();
      for (const accountId of ["active", "pending", "parked"]) {
        expect((await probe(accountId)).status).toBe(accountId === "active" ? 503 : 404);
        expect(starts.get(accountId)).toBe(1);
      }
      const retry = await rpcReq(socket, "plugins.reload", {
        plugins: [{ pluginId: "instance-binding-probe" }],
      });
      expect(retry.ok).toBe(false);
      expect(coordinator.serviceStarts).toBe(1);
      expect((await rpcReq(socket, "config.get", {})).ok).toBe(true);
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
    expect(await probe("pending")).toEqual({
      status: 200,
      body: "pending:2",
      registry: "current",
    });
    expect((await probe("parked")).status).toBe(404);
    expect(starts.get("parked")).toBe(1);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  });
});
