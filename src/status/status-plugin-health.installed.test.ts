import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { resolveGatewayStartupPluginActivationConfig } from "../gateway/plugin-activation-runtime-config.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  loadGatewayStartupPluginPlan,
} from "../plugins/gateway-startup-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { formatDetailedPluginHealth } from "./status-plugin-health.js";
import { collectInstalledPluginHealthSnapshot } from "./status-plugin-health.runtime.js";

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

const resolveReadOnlyChannelPluginsForConfigMock = vi.mocked(
  resolveReadOnlyChannelPluginsForConfig,
);
const loadGatewayStartupPluginPlanMock = vi.mocked(loadGatewayStartupPluginPlan);
const resolveGatewayStartupPluginActivationConfigMock = vi.mocked(
  resolveGatewayStartupPluginActivationConfig,
);
const collectUnregisteredConfiguredMemoryEmbeddingProvidersMock = vi.mocked(
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
);
const missingProvider = { configuredId: "custom-embed", source: "provider" } as const;
const collect = (config?: Parameters<typeof collectInstalledPluginHealthSnapshot>[0]["config"]) =>
  collectInstalledPluginHealthSnapshot({ config, workspaceDir: "/tmp/ws" });

beforeEach(() => {
  resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
    loadFailures: [],
    missingConfiguredChannelIds: [],
  } as never);
  loadGatewayStartupPluginPlanMock.mockReturnValue({ channelPluginIds: [], pluginIds: [] });
});

afterEach(() => {
  resolveReadOnlyChannelPluginsForConfigMock.mockReset();
  loadGatewayStartupPluginPlanMock.mockReset();
  resolveGatewayStartupPluginActivationConfigMock.mockClear();
  collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReset();
  collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReturnValue([]);
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
});

describe("installed plugin health should-run drift", () => {
  it("flags startup plugins that are not loaded as drift", async () => {
    await withStateDirEnv("openclaw-status-should-run-drift-", async () => {
      loadGatewayStartupPluginPlanMock.mockReturnValue({
        channelPluginIds: [],
        pluginIds: ["planned-missing", "runtime-ok"],
      });

      const registry = createEmptyPluginRegistry();
      registry.plugins.push({ id: "runtime-ok", status: "loaded", enabled: true } as never);
      setActivePluginRegistry(registry, "runtime-ok", "default", "/tmp/ws");
      const quarantine = {
        engineId: "quarantined-engine",
        operation: "bootstrap",
        reason: "startup failed",
        failedAt: new Date(123),
      };
      await recordPersistedContextEngineQuarantine(quarantine);

      const rawConfig = {} as never;
      const snapshot = await collect(rawConfig);

      expect(loadGatewayStartupPluginPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: rawConfig, activationSourceConfig: rawConfig }),
      );
      expect(snapshot.shouldRunPluginIds).toEqual(["planned-missing", "runtime-ok"]);
      expect(snapshot.contextEngineQuarantines).toEqual([quarantine]);

      const text = formatDetailedPluginHealth(snapshot);
      expect(text).toContain("Loaded: 1 (runtime-ok)");
      expect(text).toContain("Configured to run but not loaded: 1 (planned-missing)");
    });
  });

  it("builds the plan via the shared gateway helper using source + runtime config", async () => {
    await withStateDirEnv("openclaw-status-should-run-source-cfg-", async () => {
      loadGatewayStartupPluginPlanMock.mockReturnValue({
        channelPluginIds: [],
        pluginIds: [],
      });
      // /status passes the live runtime config; the activation source must be the original
      // operator source config, and the effective config must be assembled from the runtime
      // config (so runtime/defaulted fields survive) — via the shared gateway-boot helper.
      const sourceConfig = { plugins: { entries: {} } } as never;
      const runtimeConfig = { plugins: { entries: { extra: { enabled: true } } } } as never;
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      await collectInstalledPluginHealthSnapshot({
        config: runtimeConfig,
        workspaceDir: "/tmp/ws",
      });

      expect(resolveGatewayStartupPluginActivationConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeConfig, activationSourceConfig: sourceConfig }),
      );
      expect(loadGatewayStartupPluginPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: runtimeConfig, activationSourceConfig: sourceConfig }),
      );
    });
  });

  it("omits the should-run set entirely when no config is provided", async () => {
    await withStateDirEnv("openclaw-status-should-run-no-config-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      const snapshot = await collect();

      expect(snapshot.shouldRunPluginIds).toBeUndefined();
      expect(loadGatewayStartupPluginPlanMock).not.toHaveBeenCalled();
      expect(formatDetailedPluginHealth(snapshot)).not.toContain(
        "Configured to run but not loaded:",
      );
    });
  });
});

describe("installed plugin health unregistered memory embedding providers", () => {
  beforeEach(() => {
    collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReturnValue([missingProvider]);
  });
  it("surfaces configured memory embedding providers the runtime registry does not register", async () => {
    await withStateDirEnv("openclaw-status-memory-embed-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      const snapshot = await collect({});

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toEqual([missingProvider]);
      expect(collectUnregisteredConfiguredMemoryEmbeddingProvidersMock).toHaveBeenCalledWith(
        expect.objectContaining({ registeredProviderIds: expect.any(Set) }),
      );
      expect(formatDetailedPluginHealth(snapshot)).toContain(
        "Configured memory provider not registered: 1 (custom-embed (memorySearch.provider))",
      );
    });
  });

  it("skips the check and renders no line when no runtime registry is active", async () => {
    await withStateDirEnv("openclaw-status-memory-embed-no-registry-", async () => {
      resetPluginRuntimeStateForTest();
      const snapshot = await collect({});

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toBeUndefined();
      expect(collectUnregisteredConfiguredMemoryEmbeddingProvidersMock).not.toHaveBeenCalled();
      expect(formatDetailedPluginHealth(snapshot)).not.toContain(
        "Configured memory provider not registered:",
      );
    });
  });

  it("omits the check when no config is provided", async () => {
    await withStateDirEnv("openclaw-status-memory-embed-no-config-", async () => {
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      const snapshot = await collectInstalledPluginHealthSnapshot({ workspaceDir: "/tmp/ws" });

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toBeUndefined();
      expect(collectUnregisteredConfiguredMemoryEmbeddingProvidersMock).not.toHaveBeenCalled();
    });
  });
});
