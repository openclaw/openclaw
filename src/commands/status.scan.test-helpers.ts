// Status scan test helpers provide shared mocks and config fixtures for scan suites.
import type { Mock } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { withEnvAsync } from "../test-utils/env.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
const unknownMock = () => vi.fn<(...args: unknown[]) => unknown>();
type StatusScanSharedMocks = ReturnType<typeof createStatusScanSharedMocks>;
type ChannelScope = {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includePersistedAuthState?: boolean;
};

function hasConfiguredChannels(mocks: StatusScanSharedMocks, params: ChannelScope) {
  return mocks.hasConfiguredChannels(
    params.config,
    params.env,
    params.includePersistedAuthState === undefined
      ? undefined
      : { includePersistedAuthState: params.includePersistedAuthState },
  );
}

export function createStatusScanSharedMocks(configPathLabel: string) {
  return {
    resolveConfigPath: vi.fn(() => `/tmp/openclaw-${configPathLabel}-missing-${process.pid}.json`),
    resolveGatewayPort: vi.fn((cfg?: OpenClawConfig) => cfg?.gateway?.port ?? 18789),
    hasConfiguredChannels: unknownMock(),
    hasConfiguredChannelsForReadOnlyScope: unknownMock(),
    readBestEffortConfig: unknownMock(),
    readBestEffortConfigSnapshot: unknownMock(),
    resolveCommandSecretRefsViaGateway: unknownMock(),
    getUpdateCheckResult: unknownMock(),
    getAgentLocalStatuses:
      vi.fn<(cfg: OpenClawConfig) => Promise<{ defaultId: string | null; agents: unknown[] }>>(),
    getStatusSummary: unknownMock(),
    getMemorySearchManager: unknownMock(),
    buildGatewayConnectionDetails: unknownMock(),
    resolveGatewayProbeTarget: vi.fn<(...args: unknown[]) => unknown>(() => ({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    })),
    probeGateway: unknownMock(),
    resolveGatewayProbeAuthResolution: unknownMock(),
    ensurePluginRegistryLoaded: unknownMock(),
    buildPluginCompatibilityNotices: vi.fn<() => unknown[]>(() => []),
  };
}

type StatusScanModuleTestMocks = StatusScanSharedMocks & {
  buildChannelsTable?: UnknownMock;
  callGateway?: UnknownMock;
  getStatusCommandSecretTargetIds?: UnknownMock;
  resolveMemorySearchConfig?: UnknownMock;
};

export async function loadStatusScanModuleForTest(
  mocks: StatusScanModuleTestMocks,
  options: {
    fastJson: true;
  },
): Promise<typeof import("./status.scan.fast-json.js")>;
export async function loadStatusScanModuleForTest(
  mocks: StatusScanModuleTestMocks,
  options?: {
    fastJson?: false;
  },
): Promise<typeof import("./status.scan.js")>;
export async function loadStatusScanModuleForTest(
  mocks: StatusScanModuleTestMocks,
  options: {
    fastJson?: boolean;
  } = {},
) {
  vi.resetModules();
  const getStatusCommandSecretTargetIds = mocks.getStatusCommandSecretTargetIds ?? vi.fn(() => []);
  const resolveMemorySearchConfig =
    mocks.resolveMemorySearchConfig ??
    vi.fn(() => ({ store: { databasePath: "/tmp/main.sqlite" } }));

  vi.doMock("../plugins/channel-plugin-ids.js", () => ({
    hasConfiguredChannelsForReadOnlyScope: mocks.hasConfiguredChannelsForReadOnlyScope,
    listConfiguredChannelIdsForReadOnlyScope: (params: ChannelScope) =>
      hasConfiguredChannels(mocks, params) ? ["mock-channel"] : [],
  }));

  vi.doMock("../config/io.js", () => ({
    readBestEffortConfig: mocks.readBestEffortConfig,
    readBestEffortConfigSnapshot: mocks.readBestEffortConfigSnapshot,
  }));
  vi.doMock("../config/config.js", () => ({
    readBestEffortConfig: mocks.readBestEffortConfig,
    readBestEffortConfigSnapshot: mocks.readBestEffortConfigSnapshot,
    readConfigFileSnapshotWithPluginMetadata: async (readOptions: unknown) => {
      const result = (await mocks.readBestEffortConfigSnapshot(readOptions)) as {
        config: OpenClawConfig;
        sourceConfig: OpenClawConfig;
        configDiagnostics: { path: string; issues: unknown[] } | null;
      };
      return {
        snapshot: {
          path: result.configDiagnostics?.path ?? mocks.resolveConfigPath(),
          exists: false,
          raw: null,
          parsed: result.sourceConfig,
          sourceConfig: result.sourceConfig,
          resolved: result.sourceConfig,
          valid: result.configDiagnostics === null,
          runtimeConfig: result.config,
          config: result.config,
          issues: result.configDiagnostics?.issues ?? [],
          warnings: [],
          legacyIssues: [],
        },
      };
    },
    resolveGatewayPort: mocks.resolveGatewayPort,
  }));
  vi.doMock("../cli/command-secret-targets.js", () => ({
    getStatusCommandSecretTargetIds,
  }));
  vi.doMock("../cli/command-config-resolution.js", () => ({
    resolveCommandConfigWithSecrets: mocks.resolveCommandSecretRefsViaGateway,
  }));
  vi.doMock("../agents/memory-search.js", () => ({
    resolveMemorySearchConfig,
  }));

  if (!options.fastJson) {
    vi.doMock("../cli/progress.js", () => ({
      withProgress: vi.fn(async (_opts, run) => await run({ setLabel: vi.fn(), tick: vi.fn() })),
    }));
    vi.doMock("./status-all/channels.js", () => ({
      buildChannelsTable: mocks.buildChannelsTable,
    }));
    vi.doMock("./status.scan.runtime.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./status.scan.runtime.js")>()),
      buildChannelsTable: mocks.buildChannelsTable,
      collectChannelStatusIssues: vi.fn(() => []),
    }));
  }

  vi.doMock("../config/paths.js", async () => {
    const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
    return {
      ...actual,
      resolveConfigPath: mocks.resolveConfigPath,
    };
  });

  vi.doMock("../cli/command-secret-gateway.js", () => ({
    resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
  }));
  vi.doMock("./status.update.js", () => ({ getUpdateCheckResult: mocks.getUpdateCheckResult }));
  vi.doMock("./status.agent-local.js", () => ({
    collectStatusLocalSnapshot: async (cfg: OpenClawConfig) => {
      const agentStatus = await mocks.getAgentLocalStatuses(cfg);
      return {
        defaultId: agentStatus.defaultId,
        publish: () => agentStatus,
        sessionStores: undefined,
      };
    },
  }));
  vi.doMock("../status/summary.js", () => ({
    getStatusSummary: mocks.getStatusSummary,
    prepareStatusSummary: async (...args: unknown[]) => {
      const summary = await mocks.getStatusSummary(...args);
      return { publish: () => ({ summary, sessionStores: undefined }) };
    },
  }));
  vi.doMock("../infra/os-summary.js", () => ({
    resolveOsSummary: vi.fn(() => ({ label: "test-os" })),
  }));
  vi.doMock("./status.scan.deps.runtime.js", () => ({
    getMemoryProvider: vi.fn<typeof import("./status.scan.deps.runtime.js").getMemoryProvider>(
      async () => ({ provider: null }),
    ),
    getMemorySearchManager: mocks.getMemorySearchManager,
    isMemoryProviderNative: vi.fn<
      typeof import("./status.scan.deps.runtime.js").isMemoryProviderNative
    >(() => false),
  }));
  vi.doMock("../gateway/call.js", () => ({
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    ...(mocks.callGateway ? { callGateway: mocks.callGateway } : {}),
  }));
  vi.doMock("../gateway/probe.js", () => ({
    probeGateway: mocks.probeGateway,
  }));
  vi.doMock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
    waitForGatewayDiagnosticReadiness: async () => undefined,
  }));
  vi.doMock("../gateway/probe-target.js", () => ({
    resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
  }));
  vi.doMock("./status.gateway-probe.js", () => ({
    resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
  }));
  vi.doMock("../gateway/connection-details.js", () => ({
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetails,
  }));
  vi.doMock("../process/exec.js", () => ({ runExec: vi.fn() }));
  vi.doMock("../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../plugins/runtime/runtime-registry-loader.js")>()),
    ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
  }));
  vi.doMock("../plugins/status.js", () => ({
    buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
    buildPluginCompatibilitySnapshotNotices: mocks.buildPluginCompatibilityNotices,
  }));

  if (options.fastJson) {
    return await import("./status.scan.fast-json.js");
  }
  return await import("./status.scan.js");
}

export function createStatusScanConfig<T extends object = OpenClawConfig>(
  overrides: T = {} as T,
): OpenClawConfig & T {
  return {
    session: {},
    gateway: {},
    ...overrides,
  } as OpenClawConfig & T;
}

export function createStatusSummary(
  options: {
    linkChannel?: { linked: boolean };
    byAgent?: unknown[];
  } = {},
) {
  return {
    linkChannel: options.linkChannel,
    sessions: {
      count: 0,
      paths: [],
      defaults: {},
      recent: [],
      ...(Object.hasOwn(options, "byAgent") ? { byAgent: options.byAgent ?? [] } : {}),
    },
  };
}

const createStatusUpdateResult = () => ({ installKind: "git", git: null, registry: null });

function createStatusGatewayProbeFailure() {
  return {
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  };
}

export function createStatusMemorySearchConfig(): OpenClawConfig {
  return createStatusScanConfig({
    memory: {
      search: {
        provider: "local",
        local: { modelPath: "/tmp/model.gguf" },
        fallback: "none",
      },
    },
  });
}

export function createStatusMemorySearchManager() {
  return {
    manager: {
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({ files: 0, chunks: 0, dirty: false })),
      close: vi.fn(async () => {}),
    },
  };
}

export function applyStatusScanDefaults(
  mocks: StatusScanSharedMocks,
  options: {
    hasConfiguredChannels?: boolean;
    sourceConfig?: OpenClawConfig;
    resolvedConfig?: OpenClawConfig;
    summary?: ReturnType<typeof createStatusSummary>;
    update?: ReturnType<typeof createStatusUpdateResult> | false;
    gatewayProbe?: ReturnType<typeof createStatusGatewayProbeFailure> | false;
    memoryManager?: ReturnType<typeof createStatusMemorySearchManager>;
  } = {},
) {
  const sourceConfig = options.sourceConfig ?? createStatusScanConfig();
  const resolvedConfig = options.resolvedConfig ?? sourceConfig;

  mocks.hasConfiguredChannels.mockReturnValue(options.hasConfiguredChannels ?? false);
  mocks.hasConfiguredChannelsForReadOnlyScope.mockImplementation((params: unknown) =>
    Boolean(hasConfiguredChannels(mocks, params as ChannelScope)),
  );
  mocks.readBestEffortConfig.mockResolvedValue(sourceConfig);
  mocks.readBestEffortConfigSnapshot.mockResolvedValue({
    config: sourceConfig,
    sourceConfig,
    configDiagnostics: null,
  });
  mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig,
    diagnostics: [],
  });
  mocks.getAgentLocalStatuses.mockResolvedValue({ defaultId: "main", agents: [] });
  mocks.getStatusSummary.mockResolvedValue(options.summary ?? createStatusSummary());
  mocks.buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "default",
  });
  mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
    auth: {},
    warning: undefined,
  });
  mocks.ensurePluginRegistryLoaded.mockImplementation(() => {});
  mocks.buildPluginCompatibilityNotices.mockReturnValue([]);

  if (options.update !== false) {
    mocks.getUpdateCheckResult.mockResolvedValue(options.update ?? createStatusUpdateResult());
  }

  if (options.gatewayProbe !== false) {
    mocks.probeGateway.mockResolvedValue(options.gatewayProbe ?? createStatusGatewayProbeFailure());
  }

  if (options.memoryManager) {
    mocks.getMemorySearchManager.mockResolvedValue(options.memoryManager);
  }
}

export async function withTemporaryEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  await withEnvAsync(overrides, run);
}
