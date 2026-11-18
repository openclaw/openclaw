import fs from "node:fs";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { PreparedModelRuntimeLease } from "../agents/prepared-model-runtime.types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startGatewayConfigReloader } from "../gateway/config-reload.js";
import { ownedConfigReloadOptions } from "../gateway/config-reload.test-support.js";
import { installWatcherMock } from "../gateway/config-reload.watcher.test-support.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { clearActivePluginRegistry, resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSetupReloadPluginFixture,
  setupReloadModelConfig,
} from "./config-application-plugin.test-support.js";
import { executeSystemAgentOperation } from "./operations-execute.js";

// mock-isolation: Audit persistence is independent of config persistence and plugin replacement.
vi.mock("./audit.js", () => ({ appendSystemAgentAuditEntry: vi.fn() }));

beforeEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  resetPluginRuntimeStateForTest();
  resetGatewayWorkAdmission();
});
afterEach(async () => {
  await clearActivePluginRegistry();
  clearPluginMetadataLifecycleCaches();
  resetGatewayWorkAdmission();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reports a saved Setup edit while a resolved plugin tool is retained, then replaces it after the turn ends", async ({
  signal,
}) => {
  await withOpenClawTestState({ label: "setup-real-plugin-reload" }, async (state) => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    const pluginId = "setup-config-probe";
    const toolName = "setup_config_probe";
    const factoryEvent = `setup-probe-factory:${state.root}`;
    let factoryCalls = 0;
    const onFactory = () => {
      factoryCalls += 1;
    };
    process.on(factoryEvent, onFactory);
    using factoryObserver = {
      get calls() {
        return factoryCalls;
      },
      [Symbol.dispose]: () => {
        process.off(factoryEvent, onFactory);
      },
    };
    const writePlugin = (id: string, manifest: object, code: string) => {
      const root = state.path("plugins", id);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({ id, ...manifest }),
      );
      const file = path.join(root, "index.cjs");
      fs.writeFileSync(
        file,
        `module.exports = { id: ${JSON.stringify(id)}, register(api) { ${code} } };`,
      );
      return file;
    };
    const toolFile = writePlugin(
      pluginId,
      {
        contracts: { tools: [toolName] },
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: { message: { type: "string" } },
        },
        // No turnHandover opt-in: a resolved factory must retain its captured configuration.
      },
      `const message = api.pluginConfig.message;
        api.registerTool(() => { process.emit(${JSON.stringify(factoryEvent)}); return ({ name: ${JSON.stringify(toolName)}, description: "Read captured configuration",
        parameters: { type: "object", properties: {} }, async execute() {
          return { content: [{ type: "text", text: message }] };
        } }); }, { names: [${JSON.stringify(toolName)}] });`,
    );
    const providerFile = writePlugin(
      "fixture-provider",
      {
        providers: ["fixture"],
        configSchema: { type: "object", properties: {} },
      },
      "",
    );
    const initial: OpenClawConfig = {
      ...setupReloadModelConfig(state.workspaceDir),
      gateway: { mode: "local" },
      plugins: {
        allow: [pluginId, "fixture-provider"],
        load: { paths: [toolFile, providerFile] },
        slots: { memory: "none" },
        entries: {
          [pluginId]: { enabled: true, config: { message: "before" } },
          "fixture-provider": { enabled: true },
        },
      },
      tools: { allow: [toolName] },
    };
    await using fixture = await createSetupReloadPluginFixture(state, initial);
    await fixture.publish();
    const record = fixture.initial.pluginRegistry.plugins.find(({ id }) => id === pluginId);
    assert(record);
    const instance = getPluginInstance(record);
    assert(instance);
    let lease: PreparedModelRuntimeLease | undefined = await fixture.acquireTurn();
    // Merely preparing a turn or excluding the tool before factory resolution acquires no work.
    expect(factoryObserver.calls).toBe(0);
    expect(instance.retainedWorkCount, JSON.stringify(instance.retentionSnapshot())).toBe(0);
    expect(lease.run(() => fixture.tools("not-allowed-probe", lease))).toEqual([]);
    expect(instance.retainedWorkCount).toBe(0);
    expect(factoryObserver.calls).toBe(0);
    const heldTool = lease.run(() =>
      fixture.tools(toolName, lease).find(({ name }) => name === toolName),
    );
    assert(heldTool);
    expect(factoryObserver.calls).toBe(1);
    expect(lease.snapshot.pluginRegistry?.plugins.find(({ id }) => id === pluginId)).toBe(record);
    expect(instance.retainedWorkCount).toBe(1);
    const expectHeldValue = () =>
      lease!.run(async () => {
        await expect(heldTool.execute("probe-before", {})).resolves.toMatchObject({
          content: [{ type: "text", text: "before" }],
        });
      });
    await expectHeldValue();
    const watcher = installWatcherMock();
    const startWatcher = watcher.adapter.start;
    watcher.adapter.start = vi.fn(async () => {
      await startWatcher();
      watcher.emit("ready");
    });
    const clock = createGatewaySchedulerClock(Date.now());
    let scheduled = createDeferredCore();
    const scheduler = createTestGatewayScheduler({
      ...clock.clock,
      arm: (run, delay) => {
        const cancel = clock.clock.arm(run, delay);
        scheduled.resolve();
        return cancel;
      },
    });
    const wakeNext = async () => {
      if (clock.armedAtMs === null) {
        await racePromiseWithAbortSignal(scheduled.promise, signal);
      }
      scheduled = createDeferredCore();
      await clock.wake();
    };
    const applied = createDeferredCore();
    const reloadLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const onHotReload: Parameters<typeof startGatewayConfigReloader>[0]["onHotReload"] = async (
      plan,
      next,
      ownership,
    ) => {
      await ownership.checkpoint();
      const result = await fixture.reload(next, plan.changedPaths, undefined, () => {
        ownership.publishRuntimeEnv();
        setRuntimeConfigSnapshot(next);
        ownership.markRuntimeCommitted(next, plan);
      });
      return { status: "applied", runtime: result.runtime };
    };
    const reloader = startGatewayConfigReloader({
      ...(await ownedConfigReloadOptions(await readConfigFileSnapshot(), state.configPath)),
      scheduler,
      readSnapshot: () => readConfigFileSnapshot(),
      onHotReload,
      onNoopConfigCommit: async () => {},
      onConfigApplied: () => {
        applied.resolve();
      },
      onRestart: () => {
        throw new Error("fixture must hot reload");
      },
      log: reloadLog,
    });
    try {
      await reloader.ready;
      const logs: string[] = [];
      const runtime = {
        log: (...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        },
        error: (...args: unknown[]) => {
          logs.push(args.map(String).join(" "));
        },
        exit: (code: number) => {
          throw new Error(`Unexpected exit: ${code}`);
        },
      };
      const operation = executeSystemAgentOperation(
        { kind: "config-set", path: `plugins.entries.${pluginId}.config.message`, value: "after" },
        runtime,
        { approved: true },
      );
      await wakeNext();
      const result = await racePromiseWithAbortSignal(operation, signal);
      expect(result.runtimeApplication, JSON.stringify(reloadLog.error.mock.calls)).toMatchObject({
        status: "deferred",
      });
      expect(logs.join("\n")).toContain("Saved; waiting to apply");
      expect(instance.retainedWorkCount).toBe(1);
      expect(fixture.registryOwner.registry.plugins.find(({ id }) => id === pluginId)).toBe(record);
      await expectHeldValue();
      const saved: OpenClawConfig = JSON.parse(fs.readFileSync(state.configPath, "utf8"));
      expect(saved.plugins?.entries?.[pluginId]?.config?.message).toBe("after");
      await lease[Symbol.asyncDispose]();
      lease = undefined;
      await wakeNext();
      await racePromiseWithAbortSignal(applied.promise, signal);
      expect(fixture.registryOwner.registry.plugins.find(({ id }) => id === pluginId)).not.toBe(
        record,
      );
      await fixture.refresh(saved);
      await using nextLease = await fixture.acquireTurn();
      await nextLease.run(async () => {
        const nextTool = fixture
          .tools(toolName, nextLease, saved)
          .find(({ name }) => name === toolName);
        assert(nextTool);
        await expect(nextTool.execute("probe-after", {})).resolves.toMatchObject({
          content: [{ type: "text", text: "after" }],
        });
      });
    } finally {
      await lease?.[Symbol.asyncDispose]();
      await reloader.stop();
      await scheduler.stop();
      watcher.restore();
    }
  });
});
