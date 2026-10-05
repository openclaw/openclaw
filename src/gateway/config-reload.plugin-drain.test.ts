import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/config.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
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

  it.each(["explicit wait", "revert", "revert with model edit"] as const)(
    "retains a failed automatic plugin drain until recovery: %s",
    async (recovery) => {
      const initialConfig: OpenClawConfig = {
        plugins: { entries: { codex: { enabled: true, config: { sandbox: "read-only" } } } },
      };
      let config: OpenClawConfig = {
        plugins: {
          entries: { codex: { enabled: true, config: { sandbox: "workspace-write" } } },
        },
      };
      const failure = new PluginRuntimeApplicationError("admitted work did not settle", {
        operationId: "failed-automatic-drain",
        generation: getPluginRuntimeGeneration(),
        pluginIds: ["codex"],
        phase: "drain",
        committed: false,
      });
      const runtime = {
        operationId: "explicit-wait-recovery",
        generation: getPluginRuntimeGeneration(),
        pluginIds: ["codex"],
      };
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

      await flushWatcherChange(harness);
      config = {
        ...config,
        agents: { defaults: { models: { "openai/gpt-5.6-sol": { alias: "primary" } } } },
      };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.log.error).toHaveBeenCalledOnce();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();

      if (recovery !== "explicit wait") {
        config = {
          ...initialConfig,
          ...(recovery === "revert with model edit" ? { agents: config.agents } : {}),
        };
        await flushWatcherChange(harness);
        expect(harness.onConfigAccepted.mock.lastCall?.[0]).toEqual(config);
        const attempts = harness.onHotReload.mock.calls.length;
        config = {
          ...config,
          plugins: { entries: { codex: { enabled: true, config: { sandbox: "new-settings" } } } },
        };
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledTimes(attempts + 1);
        expect(harness.log.error).toHaveBeenCalledTimes(2);
        await flushWatcherChange(harness);
        expect(harness.onHotReload).toHaveBeenCalledTimes(attempts + 1);
        return;
      }

      await expect(
        harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["codex"],
          reason: "reload",
        }),
      ).rejects.toBe(failure);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      await expect(
        harness.reloader.applyPluginLifecycleChange({
          config,
          pluginIds: ["codex"],
          reason: "reload",
          waitForDrain: true,
        }),
      ).resolves.toBe(runtime);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);

      config = { ...config, agents: { defaults: { model: "openai/gpt-5.6-sol" } } };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(3);
      expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(false);
      expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    },
  );

  it.each([true, false])(
    "applies a different plugin after partial then complete reversion (existing entries: %s)",
    async (existingEntries) => {
      const codex = {
        enabled: true,
        config: { sandbox: "read-only", appServer: { args: ["--original"] } },
      };
      const other = { enabled: true, config: { value: "original" } };
      const initialConfig: OpenClawConfig = existingEntries
        ? { plugins: { entries: { codex, other } } }
        : {};
      const pendingCodex = {
        ...codex,
        config: { sandbox: "workspace-write", appServer: { args: ["--replacement"] } },
      };
      let config: OpenClawConfig = {
        plugins: { entries: { codex: pendingCodex, ...(existingEntries ? { other } : {}) } },
      };
      const harness = createReloaderHarness(async () => makeSnapshot({ config }), {
        initialConfig,
      });
      await harness.reloader.ready;
      harness.onHotReload.mockRejectedValueOnce(
        new PluginRuntimeApplicationError("admitted work did not settle", {
          operationId: "failed-codex-drain",
          generation: getPluginRuntimeGeneration(),
          pluginIds: ["codex"],
          phase: "drain",
          committed: false,
        }),
      );
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();

      const nextOther = { ...other, config: { value: "replacement" } };
      config = {
        plugins: {
          entries: {
            codex: {
              ...pendingCodex,
              config: existingEntries
                ? { ...pendingCodex.config, sandbox: codex.config.sandbox }
                : { appServer: pendingCodex.config.appServer },
            },
            other: nextOther,
          },
        },
      };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledOnce();
      expect(harness.onConfigApplied).not.toHaveBeenCalled();

      config = {
        plugins: { entries: { ...(existingEntries ? { codex } : {}), other: nextOther } },
      };
      await flushWatcherChange(harness);
      expect(harness.onHotReload).toHaveBeenCalledTimes(2);
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
    "retains only real config work after a failed manual reload: %s",
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
        withPluginLifecycleLease({}, () =>
          harness.reloader.applyPluginLifecycleChange({
            config: sourceConfig,
            pluginIds: ["notes"],
            reason: "reload",
          }),
        );
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
    "discards a late initial source read after manual failure: %s",
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
        withPluginLifecycleLease({}, () =>
          harness.reloader.applyPluginLifecycleChange({
            config,
            pluginIds: ["notes"],
            reason: "reload",
          }),
        ),
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
    const config: OpenClawConfig = {
      transcripts: { autoStart: [{ providerId: "capture", channelId: "old-room" }] },
    };
    const nextConfig: OpenClawConfig = {
      transcripts: { autoStart: [{ providerId: "capture", channelId: "new-room" }] },
    };
    const drainSignal = new AbortController().signal;
    const appliedRuntime = {
      operationId: "transcript-reload",
      generation: 2,
      pluginIds: ["notes"],
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, sourceConfig: nextConfig, hash: "next" }),
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
    try {
      const applied = harness.reloader.applyPluginLifecycleChange({
        config: nextConfig,
        pluginIds: ["notes"],
        reason: "reload",
        waitForDrain: true,
        drainSignal,
      });
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
    } finally {
      await harness.reloader.stop();
    }
  });
});
