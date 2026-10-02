import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushWatcherChange,
  makeSnapshot,
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
      plugins: { entries: { codex: { enabled: true, config: { sandbox: "workspace-write" } } } },
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

it.each([
  { existingEntries: true, partialRevertFirst: false },
  { existingEntries: true, partialRevertFirst: true },
  { existingEntries: false, partialRevertFirst: false },
  { existingEntries: false, partialRevertFirst: true },
])(
  "applies a different plugin after reverting the failed delta (existing entries: $existingEntries, partial revert first: $partialRevertFirst)",
  async ({ existingEntries, partialRevertFirst }) => {
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
    if (partialRevertFirst) {
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
    }

    config = { plugins: { entries: { ...(existingEntries ? { codex } : {}), other: nextOther } } };
    await flushWatcherChange(harness);
    expect(harness.onHotReload).toHaveBeenCalledTimes(2);
    expect(harness.onHotReload.mock.lastCall?.[0].reloadPlugins).toBe(true);
    expect(harness.onConfigApplied.mock.lastCall?.[1]).toEqual(config);
    expect(harness.log.error).toHaveBeenCalledOnce();
  },
);
