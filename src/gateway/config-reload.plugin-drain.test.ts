import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { PluginHostCleanupTimeoutError } from "../plugins/host-hook-cleanup-timeout.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  createPluginRegistryOwner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushReload,
  flushWatcherChange,
  makeSnapshot,
  makeZeroDebounceHookWrite,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";
import { PluginAdmittedWorkTimeoutError } from "./server-plugin-reload-cleanup.js";

const pluginConfig = <T extends NonNullable<OpenClawConfig["plugins"]>["entries"]>(entries: T) => ({
  plugins: { entries },
});
const codexConfig = (sandbox: string): OpenClawConfig =>
  pluginConfig({ codex: { enabled: true, config: { sandbox } } });
const pluginRuntime = (operationId: string) => ({
  operationId,
  generation: getPluginRuntimeGeneration(),
  pluginIds: ["codex"],
});
const drainFailure = (operationId: string, cause?: Error) =>
  new PluginRuntimeApplicationError(
    "admitted work did not settle",
    { ...pluginRuntime(operationId), phase: "drain", committed: false },
    { cause },
  );
type Harness = ReturnType<typeof createReloaderHarness>;
type PluginChange = Parameters<Harness["reloader"]["applyPluginLifecycleChange"]>[0];
function applyPluginChange(
  harness: Harness,
  config: OpenClawConfig,
  options: Partial<PluginChange> = {},
) {
  return harness.reloader.applyPluginLifecycleChange({
    config,
    pluginIds: ["notes"],
    reason: "reload",
    ...options,
  });
}

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecord: vi.fn(),
}));
vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readLatestConfigSnapshotAuditRecordAsync: vi.fn(async () => null),
  upsertConfigSnapshotAuditRecordAsync: vi.fn(),
}));

beforeEach((context) => {
  prepareConfigReloadTest(context);
  vi.useFakeTimers();
});
afterEach(async () => {
  await closeTestConfigReloaders();
  resetPluginRuntimeStateForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("plugin drain recovery", () => {
  it("hot-applies model settings without replacing the Codex generation", async () => {
    const initialConfig: OpenClawConfig = {
      plugins: { entries: { codex: { enabled: true } } },
    };
    let config = initialConfig;
    const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
      initialConfig,
    });
    await harness.reloader.ready;

    for (const update of [
      { agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } } } },
      { agents: { entries: { worker: { model: { primary: "openai/gpt-5.6-sol" } } } } },
      {
        models: {
          providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [] } },
        },
      },
    ] satisfies OpenClawConfig[]) {
      config = { ...initialConfig, ...update };
      await flushWatcherChange(harness);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    }
    expect(harness.onHotReload).toHaveBeenCalledTimes(3);
    expect(harness.onRestart).not.toHaveBeenCalled();
  });

  it("retries deferred replacement after work and cleanup settle", async () => {
    const initialConfig: OpenClawConfig = {
      ...codexConfig("read-only"),
      agents: { entries: { main: {} } },
    };
    let config: OpenClawConfig = { ...initialConfig, ...codexConfig("workspace-write") };
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({ id: "codex", source: "/synthetic/codex.ts" });
    builder.registry.plugins.push(record);
    builder.createApi(record, { config: {} });
    setActivePluginRegistry(builder.registry);
    const registryOwner = createPluginRegistryOwner(builder.registry);
    const instance = getPluginInstance(record);
    assert(instance);
    const releaseWork = instance.retainWork();
    const cleanup = createDeferredCore();
    let cleanupCall: Promise<void> | undefined;
    const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
      initialConfig,
      // Stands in for the reload owner's 60s pre-stop drain expiring on the held work.
      onHotReload: async (plan) => {
        if (plan.reloadPlugins && instance.retainedWorkCount > 0) {
          throw drainFailure(
            "failed-automatic-drain",
            new PluginAdmittedWorkTimeoutError(
              new Set(["codex"]),
              [instance],
              new PluginHostCleanupTimeoutError("plugin codex admitted work"),
            ),
          );
        }
        return plan.reloadPlugins
          ? { status: "applied", runtime: pluginRuntime("codex-replacement") }
          : "applied";
      },
    });
    try {
      await harness.reloader.ready;
      await flushWatcherChange(harness);
      config = { ...config, agents: { entries: { main: { skills: [] } } } };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      expect(harness.onConfigApplied).not.toHaveBeenCalled();

      // The pre-stop drain also joins cleanup calls, so the retry waits for them too.
      cleanupCall = instance.runCleanup(() => cleanup.promise);
      releaseWork();
      await flushReload(harness.reloader);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);

      cleanup.resolve();
      await cleanupCall;
      await flushReload(harness.reloader);
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
      expect(harness.log.error).toHaveBeenCalledTimes(2);
    } finally {
      await harness.reloader.stop();
      releaseWork();
      cleanup.resolve();
      await cleanupCall;
      await registryOwner.close();
    }
  });

  it("retries the full unapplied plugin delta with a later genuine config edit", async () => {
    const initialConfig: OpenClawConfig = {
      ...codexConfig("read-only"),
      agents: { entries: { main: {} } },
    };
    let config: OpenClawConfig = { ...initialConfig, ...codexConfig("workspace-write") };
    const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
      initialConfig,
    });
    await harness.reloader.ready;
    harness.onHotReload.mockRejectedValueOnce(drainFailure("failed-automatic-drain"));
    await flushWatcherChange(harness);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
    expect(harness.onConfigApplied).not.toHaveBeenCalled();
    expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    expect(harness.onConfigCandidateCommitted).not.toHaveBeenCalled();
    expect(harness.onConfigRevisionApplied).not.toHaveBeenCalled();

    config = {
      ...codexConfig("workspace-write"),
      agents: { entries: { main: { skills: [] } } },
    };
    await flushWatcherChange(harness);
    expect(harness.onHotReload).toHaveBeenCalledTimes(2);
    expect(harness.onHotReload.mock.lastCall?.[0]).toMatchObject({
      reloadPlugins: true,
      changedPaths: ["plugins.entries.codex.config.sandbox", "agents.entries.main.skills"],
    });
    expect(harness.onHotReload.mock.lastCall?.[1]).toEqual({
      plugins: { entries: { codex: { enabled: true, config: { sandbox: "workspace-write" } } } },
      agents: { entries: { main: { skills: [] } } },
    });
    expect(harness.onConfigApplied).toHaveBeenCalledOnce();
    expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
    expect(harness.onConfigAccepted.mock.lastCall?.[0]).toEqual(config);
    expect(harness.onConfigCandidateCommitted).toHaveBeenCalledOnce();
    expect(harness.onConfigCandidateCommitted.mock.lastCall?.[0].changedPaths).toEqual([
      "plugins.entries.codex.config.sandbox",
      "agents.entries.main.skills",
    ]);
    expect(harness.onConfigRevisionApplied).toHaveBeenCalledOnce();
    expect(harness.log.error).toHaveBeenCalledOnce();
  });

  it.each(["explicit wait", "revert", "revert with model edit"] as const)(
    "recovers a failed automatic plugin drain through %s",
    async (recovery) => {
      const initialConfig = codexConfig("read-only");
      let config = codexConfig("workspace-write");
      const failure = drainFailure("failed-automatic-drain");
      const runtime = pluginRuntime("explicit-wait-recovery");
      const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
        initialConfig,
        onHotReload: async (plan) => {
          if (plan.reloadPlugins && !plan.pluginLifecycle?.waitForDrain) {
            throw failure;
          }
          return plan.reloadPlugins ? { status: "applied", runtime } : "applied";
        },
      });
      await harness.reloader.ready;
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.log.error).toHaveBeenCalledOnce();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();

      if (recovery !== "explicit wait") {
        config = {
          ...initialConfig,
          ...(recovery === "revert with model edit"
            ? { agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } } } }
            : {}),
        };
        await flushWatcherChange(harness);
        expect(harness.onConfigAccepted.mock.lastCall?.[0]).toEqual(config);
        const attempts = harness.onHotReload.mock.calls.length;
        config = { ...config, ...codexConfig("new-settings") };
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledTimes(attempts + 1);
        expect(harness.log.error).toHaveBeenCalledTimes(2);
        return;
      }

      await expect(applyPluginChange(harness, config, { pluginIds: ["codex"] })).rejects.toBe(
        failure,
      );
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      await expect(
        applyPluginChange(harness, config, { pluginIds: ["codex"], waitForDrain: true }),
      ).resolves.toBe(runtime);
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);

      config = { ...config, agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(4);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    },
  );

  it.each([true, false])(
    "applies partial and complete plugin reverts with another plugin edit (%s)",
    async (existingEntries) => {
      const codex = {
        enabled: true,
        config: { sandbox: "read-only", appServer: { args: ["--original"] } },
      };
      const other = { enabled: true, config: { value: "original" } };
      const initialConfig = existingEntries ? pluginConfig({ codex, other }) : {};
      const pendingCodex = {
        ...codex,
        config: { sandbox: "workspace-write", appServer: { args: ["--replacement"] } },
      };
      let config: OpenClawConfig = pluginConfig({
        codex: pendingCodex,
        ...(existingEntries ? { other } : {}),
      });
      const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
        initialConfig,
      });
      await harness.reloader.ready;
      harness.onHotReload.mockRejectedValueOnce(drainFailure("failed-codex-drain"));
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();

      const nextOther = { ...other, config: { value: "replacement" } };
      config = pluginConfig({
        codex: {
          ...pendingCodex,
          config: existingEntries
            ? { ...pendingCodex.config, sandbox: codex.config.sandbox }
            : { appServer: pendingCodex.config.appServer },
        },
        other: nextOther,
      });
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);

      config = pluginConfig({ ...(existingEntries ? { codex } : {}), other: nextOther });
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
      expect(harness.log.error).toHaveBeenCalledOnce();
    },
  );
});

describe("plugin observations", () => {
  const runtime = { operationId: "manual", generation: 1, pluginIds: ["notes"] };
  const failure = () =>
    new PluginRuntimeApplicationError("candidate activation failed", {
      ...runtime,
      phase: "activate",
      committed: false,
    });

  it.each(["none", "file-before", "file-during", "write-during"] as const)(
    "retains real work after manual failure: %s",
    async (event) => {
      const config: OpenClawConfig = {};
      const write = makeZeroDebounceHookWrite("next");
      let snapshot = makeSnapshot({ config, hash: "initial" });
      const entered = createDeferred();
      const release = createDeferred();
      const error = failure();
      let reject = false;
      const harness = createReloaderHarness(async () => snapshot, {
        initialConfig: config,
        onHotReload: async (plan) => {
          if (plan.pluginLifecycle && reject) {
            entered.resolve();
            await release.promise;
            throw error;
          }
          return plan.pluginLifecycle ? { status: "applied", runtime } : "applied";
        },
      });
      await harness.reloader.ready;
      const reload = (sourceConfig = config) =>
        withPluginLifecycleLease({}, () => applyPluginChange(harness, sourceConfig));
      await expect(reload()).resolves.toEqual(runtime);
      harness.onConfigAccepted.mockClear();
      if (event === "file-before") {
        snapshot = write.snapshot;
        harness.watcher.emit("change");
      }
      reject = true;
      const result = reload(snapshot.sourceConfig).catch((caught: unknown) => caught);
      try {
        await entered.promise;
        if (event === "file-during" || event === "write-during") {
          snapshot = write.snapshot;
          if (event === "write-during") {
            harness.emitWrite(write);
          } else {
            harness.watcher.emit("change");
          }
          await vi.advanceTimersByTimeAsync(0);
        }
        release.resolve();
        expect(await result).toBe(error);
        await flushReload(harness.reloader);
        expect(harness.onConfigAccepted).toHaveBeenCalledTimes(event === "none" ? 0 : 1);
        if (event !== "none") {
          expect(harness.onConfigAccepted.mock.calls[0]?.[2]).toEqual(write.sourceConfig);
        }
        // A later genuine observation remains admissible after either outcome.
        harness.onConfigAccepted.mockClear();
        harness.watcher.emit("change");
        await flushReload(harness.reloader);
        expect(harness.onConfigAccepted).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await result;
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "discards stale reads after manual failure: %s",
    async (outcome) => {
      const initialRead = createDeferred<ConfigFileSnapshot>();
      const config: OpenClawConfig = {};
      const snapshot = makeSnapshot({ config, hash: "same" });
      const readSnapshot = vi
        .fn<() => Promise<ConfigFileSnapshot>>()
        .mockImplementationOnce(() => initialRead.promise)
        .mockResolvedValue(snapshot);
      const error = failure();
      const harness = createReloaderHarness(readSnapshot, {
        initialConfig: config,
        onHotReload: async () => {
          throw error;
        },
      });
      await harness.reloader.ready;
      harness.watcher.emit("ready");
      await expect(
        withPluginLifecycleLease({}, () => applyPluginChange(harness, config)),
      ).rejects.toBe(error);
      if (outcome === "reject") {
        initialRead.reject(new Error("old read failed"));
      } else {
        initialRead.resolve(makeSnapshot({ exists: false, valid: false }));
      }
      await flushReload(harness.reloader);
      expect(readSnapshot).toHaveBeenCalledTimes(2);
      expect(harness.onConfigAccepted).not.toHaveBeenCalled();
    },
  );

  it("applies transcript changes through the plugin reload transaction without a plugin policy", async () => {
    const registry = createTestRegistry([]);
    setActivePluginRegistry(registry);
    const transcriptConfig = (channelId: string): OpenClawConfig => ({
      transcripts: { autoStart: [{ providerId: "capture", channelId }] },
    });
    const config = transcriptConfig("old-room");
    const nextConfig = transcriptConfig("new-room");
    const drainSignal = new AbortController().signal;
    const appliedRuntime = {
      operationId: "transcript-reload",
      generation: 2,
      pluginIds: ["notes"],
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, hash: "next" }),
      {
        initialConfig: config,
        initialCompareConfig: config,
        onHotReload: async (plan, next, ownership) => {
          ownership.markRuntimeCommitted(next, plan);
          return { status: "applied", runtime: appliedRuntime };
        },
      },
    );
    await harness.reloader.ready;
    const applied = applyPluginChange(harness, nextConfig, { waitForDrain: true, drainSignal });
    await expect(applied).resolves.toEqual(appliedRuntime);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
    expect(harness.onHotReload.mock.calls[0]?.[0]).toMatchObject({
      pluginLifecycle: { waitForDrain: true, drainSignal },
      reloadPlugins: true,
      restartGateway: false,
      changedPaths: ["transcripts.autoStart"],
    });
    expect(harness.onHotReload.mock.calls[0]?.[1]).toEqual(nextConfig);
    expect(harness.onRestart).not.toHaveBeenCalled();
  });
});
