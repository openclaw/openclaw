import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { recordPersistedRuntimeToolSchemaQuarantine as recordTool } from "../agents/tool-schema-quarantine-health.js";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  clearPersistedContextEngineQuarantineForProcess as clearEngine,
  recordPersistedContextEngineQuarantine as recordEngine,
} from "../context-engine/quarantine-health.js";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
import { resolveGatewayStartupPluginActivationConfig } from "../gateway/plugin-activation-runtime-config.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import { createRuntimeHealthRecordEnvelope } from "../plugin-state/runtime-health-store.js";
import {
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  loadGatewayStartupPluginPlan,
} from "../plugins/gateway-startup-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { formatDetailedPluginHealth } from "./status-plugin-health.js";
import {
  collectInstalledPluginHealthSnapshot as collectInstalled,
  collectRuntimePluginHealthSnapshot as collectRuntime,
} from "./status-plugin-health.runtime.js";

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));

// Only seeded runtime records participate in these installed snapshots.
vi.mock("../plugins/status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/status.js")>();
  const emptyReport = { plugins: [], diagnostics: [] } as unknown as ReturnType<
    typeof actual.buildPluginSnapshotReport
  >;
  return {
    ...actual,
    buildPluginSnapshotReport: vi.fn(() => emptyReport),
    buildPluginCompatibilityNotices: vi.fn(() => []),
  } as typeof actual;
});
vi.mock("../plugins/gateway-startup-plugin-ids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/gateway-startup-plugin-ids.js")>();
  return {
    ...actual,
    loadGatewayStartupPluginPlan: vi.fn(),
    collectUnregisteredConfiguredMemoryEmbeddingProviders: vi.fn(() => []),
  } as typeof actual;
});
vi.mock("../gateway/plugin-activation-runtime-config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../gateway/plugin-activation-runtime-config.js")>();
  return {
    ...actual,
    resolveGatewayStartupPluginActivationConfig: vi.fn(
      (params: { runtimeConfig: unknown }) =>
        params.runtimeConfig as ReturnType<
          typeof actual.resolveGatewayStartupPluginActivationConfig
        >,
    ),
  } as typeof actual;
});

const channelsMock = vi.mocked(resolveReadOnlyChannelPluginsForConfig);
const toolQuarantine = (toolName: string, failedAt: number, owner?: string) => ({
  toolName,
  reason: "unsupported schema",
  failedAt: new Date(failedAt),
  ...(owner ? { owner } : {}),
});
const activate = (registry = createEmptyPluginRegistry(), key = "empty") =>
  setActivePluginRegistry(registry, key, "default", "/tmp/ws");
const engineQuarantine = (engineId: string, reason: string, owner?: string) => ({
  engineId,
  reason,
  operation: "bootstrap",
  failedAt: new Date(123),
  ...(owner ? { owner } : {}),
});
function activatePlugins(...plugins: Array<[string, "loaded" | "error" | "disabled"]>) {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    ...plugins.map(([id, status]) => ({ id, status, enabled: status !== "disabled" }) as never),
  );
  activate(registry);
}
const inState = (run: () => Promise<void>) => () => withStateDirEnv("openclaw-status-health-", run);

afterEach(() => {
  channelsMock.mockReset();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
});

async function deadProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) {
    throw new Error("failed to spawn short-lived process");
  }
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  return pid;
}

function seedPersistedToolQuarantineForTest(
  record: ReturnType<typeof createRuntimeHealthRecordEnvelope> & {
    toolName: string;
    owner?: string;
    reason: string;
  },
): void {
  createCorePluginStateSyncKeyedStore<typeof record>({
    ownerId: "core:runtime-tool-quarantine-health",
    namespace: "schema-quarantines",
    maxEntries: 128,
    defaultTtlMs: 24 * 60 * 60 * 1_000,
  }).register(JSON.stringify([record.owner ?? "", record.toolName, record.processId]), record);
}

describe("runtime plugin health snapshot", () => {
  it.each(["clear", "replace"] as const)(
    "settles an overlapping snapshot and observes %s on the next read",
    async (change) => {
      await withStateDirEnv("openclaw-status-quarantine-recovery-", async () => {
        await resetContextEngineRuntimeQuarantineForTests();
        const quarantine = engineQuarantine("recovered-engine", "temporary failure");
        await recordEngine(quarantine);
        const tool = toolQuarantine("still-quarantined-tool", 456);
        await recordTool(tool);
        const captured = createDeferredCore<unknown>();
        const release = createDeferredCore();
        const listEntries = pluginStateWorker.listPluginStateInWorker;
        let held = false;
        const observation = vi
          .spyOn(pluginStateWorker, "listPluginStateInWorker")
          .mockImplementation(async (params) => {
            const entries = await listEntries(params);
            if (params.namespace === "runtime-quarantines" && !held) {
              held = true;
              captured.resolve(entries);
              await release.promise;
            }
            return entries;
          });
        const pending = collectRuntime();
        try {
          expect(await captured.promise).toEqual([
            expect.objectContaining({
              value: expect.objectContaining({ engineId: "recovered-engine" }),
            }),
          ]);
          await clearEngine("recovered-engine", process.pid);
          const replacement = { ...quarantine, reason: "new failure", failedAt: new Date(789) };
          if (change === "replace") {
            await recordEngine(replacement);
          }
          release.resolve();
          const snapshot = await pending;
          expect(snapshot.contextEngineQuarantines).toEqual([quarantine]);
          expect(snapshot.runtimeToolQuarantines).toEqual([tool]);
          const nextSnapshot = await collectRuntime();
          expect(nextSnapshot.contextEngineQuarantines).toEqual(
            change === "replace" ? [replacement] : [],
          );
        } finally {
          release.resolve();
          await pending;
          observation.mockRestore();
        }
      });
    },
  );

  it(
    "reads persisted engines without caller-thread SQLite",
    inState(async () => {
      await resetContextEngineRuntimeQuarantineForTests();
      const quarantine = engineQuarantine(
        "lossless-claw",
        "intentional bootstrap failure",
        "plugin:lossless-claw",
      );
      await recordEngine(quarantine);

      const observation = observeHostDataSql();
      let snapshot;
      try {
        snapshot = await collectRuntime();
        expect(observation.queries).toEqual([]);
      } finally {
        observation.restore();
      }
      expect(snapshot.contextEngineQuarantines).toEqual([quarantine]);
    }),
  );

  it(
    "drops tools from dead or unverifiable recorder processes",
    inState(async () => {
      activate();
      seedPersistedToolQuarantineForTest({
        toolName: "stale_tool",
        reason: "unsupported schema",
        failedAtMs: 123,
        processId: await deadProcessId(),
        processToken: "dead-process-token",
        processStartTime: null,
      });
      seedPersistedToolQuarantineForTest({
        toolName: "live_tool",
        reason: "unsupported schema",
        ...createRuntimeHealthRecordEnvelope(new Date(456)),
      });

      expect((await collectRuntime()).runtimeToolQuarantines).toEqual([
        toolQuarantine("live_tool", 456),
      ]);
    }),
  );

  it(
    "drops quarantines from a previous incarnation of this PID",
    inState(async () => {
      activate();
      seedPersistedToolQuarantineForTest({
        toolName: "reused_pid_tool",
        reason: "unsupported schema",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
        processToken: "stale-incarnation-token",
      });

      expect((await collectRuntime()).runtimeToolQuarantines).toEqual([]);
    }),
  );

  it(
    "hides persisted tool quarantines while their owner is gone",
    inState(async () => {
      const tool = {
        ...toolQuarantine("bad_tool", 456, "plugin:bad-tools"),
        reason: "unsupported anyOf",
      };
      await recordTool(tool);

      activate();
      expect((await collectRuntime()).runtimeToolQuarantines).toEqual([]);

      activatePlugins(["bad-tools", "loaded"]);

      expect((await collectRuntime()).runtimeToolQuarantines).toEqual([tool]);
    }),
  );

  it("does not inspect configured channel plugins for compact runtime health", async () => {
    const registry = createEmptyPluginRegistry();
    registry.diagnostics.push({
      level: "error",
      pluginId: "broken-channel",
      code: "channel-setup-failure",
      message: "failed to load setup entry: boom",
    });
    activate(registry, "broken-channel");

    const snapshot = await collectRuntime();

    expect(snapshot.channelPluginFailures).toEqual([
      {
        channelId: "broken-channel",
        pluginId: "broken-channel",
        message: "failed to load setup entry: boom",
        source: "diagnostic",
      },
    ]);
    expect(channelsMock).not.toHaveBeenCalled();
  });

  it("records only runtime status:loaded plugins as runtime-loaded", async () => {
    activatePlugins(
      ["runtime-ok", "loaded"],
      ["runtime-broken", "error"],
      ["runtime-off", "disabled"],
    );

    expect((await collectRuntime()).runtimeLoadedPluginIds).toEqual(["runtime-ok"]);
  });
});

const planMock = vi.mocked(loadGatewayStartupPluginPlan);
const activationMock = vi.mocked(resolveGatewayStartupPluginActivationConfig);
const missingProvidersMock = vi.mocked(collectUnregisteredConfiguredMemoryEmbeddingProviders);
const missingProvider = { configuredId: "custom-embed", source: "provider" } as const;
const collect = (config?: Parameters<typeof collectInstalled>[0]["config"]) =>
  collectInstalled({ config, workspaceDir: "/tmp/ws" });

describe("installed plugin health", () => {
  beforeEach(() => {
    channelsMock.mockReturnValue({
      loadFailures: [],
      missingConfiguredChannelIds: [],
    } as never);
    planMock.mockReturnValue({ channelPluginIds: [], pluginIds: [] });
  });

  afterEach(() => {
    planMock.mockReset();
    activationMock.mockClear();
    missingProvidersMock.mockReset();
    missingProvidersMock.mockReturnValue([]);
    clearRuntimeConfigSnapshot();
  });

  it(
    "flags startup plugins that are not loaded as drift",
    inState(async () => {
      planMock.mockReturnValue({
        channelPluginIds: [],
        pluginIds: ["planned-missing", "runtime-ok"],
      });

      activatePlugins(["runtime-ok", "loaded"]);
      const quarantine = engineQuarantine("quarantined-engine", "startup failed");
      await recordEngine(quarantine);

      const rawConfig = {} as never;
      const snapshot = await collect(rawConfig);

      expect(planMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: rawConfig, activationSourceConfig: rawConfig }),
      );
      expect([snapshot.shouldRunPluginIds, snapshot.contextEngineQuarantines]).toEqual([
        ["planned-missing", "runtime-ok"],
        [quarantine],
      ]);

      const text = formatDetailedPluginHealth(snapshot);
      expect(text).toContain("Loaded: 1 (runtime-ok)");
      expect(text).toContain("Configured to run but not loaded: 1 (planned-missing)");
    }),
  );

  it(
    "plans through the gateway helper with source and runtime config",
    inState(async () => {
      const sourceConfig = { plugins: { entries: {} } } as never;
      const runtimeConfig = { plugins: { entries: { extra: { enabled: true } } } } as never;
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      activate();

      await collect(runtimeConfig);

      expect(activationMock).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeConfig, activationSourceConfig: sourceConfig }),
      );
      expect(planMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: runtimeConfig, activationSourceConfig: sourceConfig }),
      );
    }),
  );

  it(
    "omits the should-run set entirely when no config is provided",
    inState(async () => {
      activate();

      const snapshot = await collect();

      expect(snapshot.shouldRunPluginIds).toBeUndefined();
      expect(snapshot.unregisteredMemoryEmbeddingProviders).toBeUndefined();
      expect(missingProvidersMock).not.toHaveBeenCalled();
      expect(planMock).not.toHaveBeenCalled();
      expect(formatDetailedPluginHealth(snapshot)).not.toContain(
        "Configured to run but not loaded:",
      );
    }),
  );

  it(
    "reports configured but unregistered memory providers",
    inState(async () => {
      missingProvidersMock.mockReturnValue([missingProvider]);
      activate();

      const snapshot = await collect({});

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toEqual([missingProvider]);
      expect(missingProvidersMock).toHaveBeenCalledWith(
        expect.objectContaining({ registeredProviderIds: expect.any(Set) }),
      );
      expect(formatDetailedPluginHealth(snapshot)).toContain(
        "Configured memory provider not registered: 1 (custom-embed (memorySearch.provider))",
      );
    }),
  );

  it(
    "skips the check and renders no line without a runtime registry",
    inState(async () => {
      missingProvidersMock.mockReturnValue([missingProvider]);
      resetPluginRuntimeStateForTest();
      const snapshot = await collect({});

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toBeUndefined();
      expect(missingProvidersMock).not.toHaveBeenCalled();
      expect(formatDetailedPluginHealth(snapshot)).not.toContain(
        "Configured memory provider not registered:",
      );
    }),
  );
});
