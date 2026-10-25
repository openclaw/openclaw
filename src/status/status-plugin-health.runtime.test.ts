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
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import {
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  loadGatewayStartupPluginPlan,
} from "../plugins/gateway-startup-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
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

describe("runtime plugin health snapshot", () => {
  it.each(["clear", "replace"] as const)(
    "settles an overlapping snapshot and observes %s on the next read",
    async (change) => {
      await withStateDirEnv("openclaw-status-quarantine-recovery-", async () => {
        await resetContextEngineRuntimeQuarantineForTests();
        const quarantine = engineQuarantine(
          "recovered-engine",
          "temporary failure",
          "plugin:engine",
        );
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
        const sql = observeHostDataSql();
        const pending = collectRuntime();
        try {
          await captured.promise;
          await clearEngine("recovered-engine", process.pid);
          const replacement = { ...quarantine, reason: "new failure", failedAt: new Date(789) };
          if (change === "replace") {
            await recordEngine(replacement);
          }
          release.resolve();
          const snapshot = await pending;
          expect(sql.queries).toEqual([]);
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
          sql.restore();
        }
      });
    },
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

      activatePlugins(["bad-tools", "loaded"], ["broken", "error"], ["off", "disabled"]);
      const snapshot = await collectRuntime();
      expect(snapshot.runtimeToolQuarantines).toEqual([tool]);
      expect(snapshot.runtimeLoadedPluginIds).toEqual(["bad-tools"]);
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
});

const planMock = vi.mocked(loadGatewayStartupPluginPlan);
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
    missingProvidersMock.mockReset();
    missingProvidersMock.mockReturnValue([]);
    clearRuntimeConfigSnapshot();
  });

  it(
    "plans startup drift with source config while retaining persisted health",
    inState(async () => {
      const sourceConfig = { plugins: { entries: {} } };
      const runtimeConfig = { plugins: { entries: { extra: { enabled: true } } } };
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      planMock.mockReturnValue({
        channelPluginIds: [],
        pluginIds: ["planned-missing", "runtime-ok"],
      });

      activatePlugins(["runtime-ok", "loaded"]);
      const quarantine = engineQuarantine("quarantined-engine", "startup failed");
      await recordEngine(quarantine);

      const snapshot = await collect(runtimeConfig);
      expect(planMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: runtimeConfig, activationSourceConfig: sourceConfig }),
      );
      expect([snapshot.shouldRunPluginIds, snapshot.contextEngineQuarantines]).toEqual([
        ["planned-missing", "runtime-ok"],
        [quarantine],
      ]);
    }),
  );

  it.each([
    ["no config", undefined, true],
    ["unregistered provider", {}, true],
    ["no runtime registry", {}, false],
  ] as const)("collects installed health with %s", async (_name, config, registry) => {
    await inState(async () => {
      missingProvidersMock.mockReturnValue(config ? [missingProvider] : []);
      if (registry) {
        activate();
      } else {
        resetPluginRuntimeStateForTest();
      }
      const snapshot = await collect(config);
      expect(snapshot.unregisteredMemoryEmbeddingProviders).toEqual(
        config && registry ? [missingProvider] : undefined,
      );
      if (!config || !registry) {
        expect(missingProvidersMock).not.toHaveBeenCalled();
      }
      if (!config) {
        expect(snapshot.shouldRunPluginIds).toBeUndefined();
        expect(planMock).not.toHaveBeenCalled();
      }
    })();
  });
});
