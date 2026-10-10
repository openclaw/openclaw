// Config reload observation tests: the reloader publishes the source config each
// completed transaction read, which runtime-config health compares with the live runtime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildRuntimeConfigHealth } from "../commands/health-runtime-config.js";
import type { ConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { getConfigReloadObservation } from "./config-reload-observed.js";
import {
  closeTestConfigReloaders,
  createReloaderHarness,
  flushReload,
  makeSnapshot,
  makeWrite,
  prepareConfigReloadTest,
  waitForReloadState,
} from "./config-reload.test-support.js";

const configAuditMocks = vi.hoisted(() => ({
  append: vi.fn(),
  readSnapshot: vi.fn(),
  readLatestSnapshot: vi.fn(),
  upsertSnapshot: vi.fn(),
}));

vi.mock("../config/io.audit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.audit.js")>()),
  appendConfigAuditRecordSync: configAuditMocks.append,
}));

vi.mock("../config/config-journal-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config-journal-snapshot.js")>()),
  readConfigSnapshotAuditRecord: configAuditMocks.readSnapshot,
  readLatestConfigSnapshotAuditRecord: configAuditMocks.readLatestSnapshot,
  upsertConfigSnapshotAuditRecord: configAuditMocks.upsertSnapshot,
}));

const DRIFT_MESSAGE =
  "Live gateway runtime config differs from the latest completed reload observation for model/provider/auth paths; restart is required or pending.";

describe("config reload observation", () => {
  beforeEach((context) => {
    prepareConfigReloadTest(context);
    resetGatewayWorkAdmission();
    configAuditMocks.readSnapshot.mockReset().mockReturnValue(null);
    configAuditMocks.readLatestSnapshot.mockReset().mockReturnValue(null);
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await closeTestConfigReloaders();
    resetGatewayWorkAdmission();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes the initial source, then each completed read including mode off", async () => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: "openai/gpt-5.6-sol" } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: "openai/gpt-5.6-terra" } },
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, hash: "mode-off-write" }),
      { initialConfig },
    );
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;
    expect(getConfigReloadObservation().sourceConfig).toEqual(initialConfig);

    harness.watcher.emit("change");
    await flushReload(harness.reloader);

    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: nextConfig,
    });
    await harness.reloader.stop();
  });

  it("publishes an invalid candidate as an unavailable source", async () => {
    const harness = createReloaderHarness(
      async () =>
        makeSnapshot({
          valid: false,
          issues: [{ path: "gateway.port", message: "Expected number" }],
          hash: "invalid",
        }),
      { initialConfig: { gateway: { reload: {} } } },
    );
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;

    harness.watcher.emit("change");
    await flushReload(harness.reloader);

    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: null,
    });
    await harness.reloader.stop();
  });

  it.each([
    {
      name: "the default model",
      initial: { agents: { defaults: { model: "openai/gpt-5.6-sol" } } },
      next: {
        agents: { defaults: { model: "openai/gpt-5.6-terra" } },
        ui: { prefs: { themeMode: "dark" as const } },
      },
      ok: { liveDefaultModel: "openai/gpt-5.6-sol", observedDefaultModel: "openai/gpt-5.6-sol" },
      drift: {
        liveDefaultModel: "openai/gpt-5.6-sol",
        observedDefaultModel: "openai/gpt-5.6-terra",
        driftPaths: ["agents.defaults.model"],
      },
    },
    {
      name: "the secret provider selection",
      initial: {
        secrets: {
          defaults: { env: "primary" },
          providers: { primary: { source: "env" as const }, secondary: { source: "env" as const } },
        },
      },
      next: {
        secrets: {
          defaults: { env: "secondary" },
          providers: { primary: { source: "env" as const }, secondary: { source: "env" as const } },
        },
      },
      ok: { liveDefaultModel: null, observedDefaultModel: null },
      drift: { liveDefaultModel: null, observedDefaultModel: null, driftPaths: ["secrets"] },
    },
  ])("keeps health on the prior observation until $name read completes", async (fixture) => {
    const initialConfig: OpenClawConfig = {
      gateway: { reload: { mode: "off" } },
      ...fixture.initial,
    };
    const nextConfig: OpenClawConfig = { gateway: { reload: { mode: "off" } }, ...fixture.next };
    const snapshot = createDeferred<ConfigFileSnapshot>();
    const readSnapshot = vi.fn(() => snapshot.promise);
    const harness = createReloaderHarness(readSnapshot, { initialConfig });
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;
    const health = () =>
      buildRuntimeConfigHealth({
        liveSourceConfig: initialConfig,
        hasLiveSnapshot: true,
        observedSourceConfig: getConfigReloadObservation().sourceConfig,
      });

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await waitForReloadState(() => readSnapshot.mock.calls.length === 1);

    expect(getConfigReloadObservation().generation).toBe(observedGeneration);
    expect(health()).toEqual({ state: "ok", ...fixture.ok });

    snapshot.resolve(makeSnapshot({ config: nextConfig, hash: `completed-${fixture.name}` }));
    await flushReload(harness.reloader);

    expect(getConfigReloadObservation().generation).toBe(observedGeneration + 1);
    expect(health()).toEqual({ state: "drift", ...fixture.drift, message: DRIFT_MESSAGE });
    await harness.reloader.stop();
  });

  it("publishes only the newest source when a watcher supersedes an active read", async () => {
    const model = (primary: string): OpenClawConfig => ({
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: primary } },
    });
    const supersededRead = createDeferred<ConfigFileSnapshot>();
    const newestRead = createDeferred<ConfigFileSnapshot>();
    const readSnapshot = vi
      .fn<() => Promise<ConfigFileSnapshot>>()
      .mockImplementationOnce(() => supersededRead.promise)
      .mockImplementationOnce(() => newestRead.promise);
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: model("openai/gpt-5.6-sol"),
    });
    await harness.reloader.ready;
    const initialObservation = getConfigReloadObservation();

    harness.watcher.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    await waitForReloadState(() => readSnapshot.mock.calls.length === 1);
    harness.watcher.emit("change");
    supersededRead.resolve(makeSnapshot({ config: model("openai/gpt-5.6-terra"), hash: "old" }));
    await vi.advanceTimersByTimeAsync(0);
    await waitForReloadState(() => readSnapshot.mock.calls.length === 2);
    expect(getConfigReloadObservation()).toEqual(initialObservation);

    newestRead.resolve(makeSnapshot({ config: model("openai/gpt-5.6-luna"), hash: "new" }));
    await flushReload(harness.reloader);

    expect(getConfigReloadObservation()).toEqual({
      generation: initialObservation.generation + 1,
      sourceConfig: model("openai/gpt-5.6-luna"),
    });
    await harness.reloader.stop();
  });

  it("publishes an in-process restart write's source once its transaction completes", async () => {
    const previousConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hot" } },
      agents: { defaults: { model: "openai-codex/gpt-5.5" } },
    };
    const nextConfig: OpenClawConfig = {
      gateway: { reload: { mode: "hot" } },
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    const harness = createReloaderHarness(
      async () => makeSnapshot({ config: nextConfig, hash: "hot-model-restart" }),
      { initialConfig: previousConfig },
    );
    await harness.reloader.ready;

    harness.emitWrite(
      makeWrite(nextConfig, "hot-model-restart", {
        afterWrite: { mode: "restart", reason: "model/provider runtime changed" },
      }),
    );
    await flushReload(harness.reloader);

    expect(harness.onRestart).toHaveBeenCalledOnce();
    const [plan, restartConfig] = harness.onRestart.mock.calls[0] ?? [];
    expect(plan?.restartReasons).toEqual(["model/provider runtime changed"]);
    expect(restartConfig).toBe(nextConfig);
    expect(getConfigReloadObservation().sourceConfig).toEqual(nextConfig);
    await harness.reloader.stop();
  });

  it("publishes a slow in-process write's source when it accepts its own watcher echo", async () => {
    const model = (primary: string): OpenClawConfig => ({
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: primary } },
    });
    const initialConfig = model("openai/gpt-5.6-sol");
    const nextConfig = model("openai/gpt-5.6-terra");
    const pluginReadStarted = createDeferred();
    const pluginReadGate = createDeferred();
    const readPluginInstallRecords = vi.fn(async () => {
      pluginReadStarted.resolve();
      await pluginReadGate.promise;
      return {};
    });
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "slow-off" }));
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      readPluginInstallRecords,
    });
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;

    harness.emitWrite(makeWrite(nextConfig, "slow-off"));
    await vi.advanceTimersByTimeAsync(0);
    await pluginReadStarted.promise;
    // The write's own filesystem echo lands while its transaction is still running.
    harness.watcher.emit("change");
    pluginReadGate.resolve();
    await flushReload(harness.reloader);

    // The write carries its snapshot; the only read is the echo its checkpoint accepted.
    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: nextConfig,
    });
    expect(
      buildRuntimeConfigHealth({
        liveSourceConfig: initialConfig,
        hasLiveSnapshot: true,
        observedSourceConfig: getConfigReloadObservation().sourceConfig,
      }),
    ).toEqual({
      state: "drift",
      liveDefaultModel: "openai/gpt-5.6-sol",
      observedDefaultModel: "openai/gpt-5.6-terra",
      driftPaths: ["agents.defaults.model"],
      message: DRIFT_MESSAGE,
    });
    await harness.reloader.stop();
  });

  it("publishes a plugin lifecycle read that consumes a pending write and accepts its echo", async () => {
    const model = (primary: string): OpenClawConfig => ({
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: primary } },
    });
    const initialConfig = model("openai/gpt-5.6-sol");
    const nextConfig = model("openai/gpt-5.6-terra");
    const write = makeWrite(nextConfig, "plugin-write");
    const readSnapshot = vi.fn(async () => write.snapshot);
    const runtimeStarted = createDeferred();
    const finishRuntime = createDeferred();
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig,
      onHotReload: async (plan) => {
        runtimeStarted.resolve();
        await finishRuntime.promise;
        return {
          status: "applied",
          runtime: {
            operationId: plan.pluginLifecycle!.operationId!,
            generation: 2,
            pluginIds: ["notes"],
          },
        };
      },
    });
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;

    // A plugin install persists config, then applies it before the write's own reload runs.
    harness.emitWrite(write);
    const application = harness.reloader.applyPluginLifecycleChange({
      config: nextConfig,
      write: { persistedHash: "plugin-write", persistedSourceConfig: nextConfig },
      pluginIds: ["notes"],
      reason: "install",
    });
    await runtimeStarted.promise;
    // The write's filesystem echo lands while the plugin runtime is applying.
    harness.watcher.emit("change");
    finishRuntime.resolve();
    await expect(application).resolves.toMatchObject({ generation: 2 });
    await flushReload(harness.reloader);

    // The lifecycle read, then the echo its checkpoint accepted; no follow-up reload.
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(harness.onHotReload).toHaveBeenCalledOnce();
    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: nextConfig,
    });
    expect(
      buildRuntimeConfigHealth({
        liveSourceConfig: nextConfig,
        hasLiveSnapshot: true,
        observedSourceConfig: getConfigReloadObservation().sourceConfig,
      }),
    ).toEqual({
      state: "ok",
      liveDefaultModel: "openai/gpt-5.6-terra",
      observedDefaultModel: "openai/gpt-5.6-terra",
    });
    await harness.reloader.stop();
  });

  it.each([
    { outcome: "a missing file", observed: null },
    { outcome: "an invalid file", observed: null },
    { outcome: "replaced bytes", observed: "openai/gpt-5.6-luna" },
  ])("publishes a pending write's canonical reread after $outcome", async (fixture) => {
    const model = (primary: string): OpenClawConfig => ({
      gateway: { reload: { mode: "off" } },
      agents: { defaults: { model: primary } },
    });
    const nextConfig = model("openai/gpt-5.6-terra");
    // The writer's final reread rides on the notification; the reloader refuses
    // a missing, invalid or replaced one, but health must still see what it found.
    const reread = (): ConfigFileSnapshot => {
      switch (fixture.outcome) {
        case "a missing file":
          return makeSnapshot({ exists: false, raw: null, hash: undefined });
        case "an invalid file":
          return makeSnapshot({
            valid: false,
            issues: [{ path: "gateway.port", message: "Expected number" }],
            hash: "invalid",
          });
        default:
          return makeSnapshot({ config: model("openai/gpt-5.6-luna"), hash: "replaced" });
      }
    };
    const readSnapshot = vi.fn(async () => makeSnapshot({ config: nextConfig, hash: "queued" }));
    const harness = createReloaderHarness(readSnapshot, {
      initialConfig: model("openai/gpt-5.6-sol"),
    });
    await harness.reloader.ready;
    const observedGeneration = getConfigReloadObservation().generation;

    harness.emitWrite(makeWrite(nextConfig, "queued", { snapshot: reread() }));
    await flushReload(harness.reloader);

    expect(readSnapshot).not.toHaveBeenCalled();
    expect(getConfigReloadObservation()).toEqual({
      generation: observedGeneration + 1,
      sourceConfig: fixture.observed === null ? null : model(fixture.observed),
    });
    await harness.reloader.stop();
  });
});
