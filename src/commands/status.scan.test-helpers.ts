// Status scan test helpers provide shared mocks and config fixtures for scan suites.
import type { Mock } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { createTestConfigSnapshot } from "./test-runtime-config-helpers.js";

type UnknownMock = Mock<(...args: unknown[]) => unknown>;
type ResolveConfigPathMock = Mock<() => string>;
type ReadConfigSnapshot =
  typeof import("../config/config.js").readConfigFileSnapshotWithPluginMetadata;

type StatusScanSharedMocks = {
  resolveConfigPath: ResolveConfigPathMock;
  resolveGatewayPort: Mock<(cfg?: OpenClawConfig) => number>;
  hasConfiguredChannels: UnknownMock;
  hasConfiguredChannelsForReadOnlyScope: UnknownMock;
  readConfigFileSnapshotWithPluginMetadata: Mock<ReadConfigSnapshot>;
  resolveCommandSecretRefsViaGateway: UnknownMock;
  getUpdateCheckResult: UnknownMock;
  getAgentLocalStatuses: Mock<
    (cfg: OpenClawConfig) => Promise<{ defaultId: string | null; agents: unknown[] }>
  >;
  getStatusSummary: UnknownMock;
  getMemorySearchManager: UnknownMock;
  buildGatewayConnectionDetails: UnknownMock;
  resolveGatewayProbeTarget: UnknownMock;
  probeGateway: UnknownMock;
  resolveGatewayProbeAuthResolution: UnknownMock;
  ensurePluginRegistryLoaded: UnknownMock;
  buildPluginCompatibilityNotices: Mock<() => unknown[]>;
};

export function createStatusScanSharedMocks(configPathLabel: string): StatusScanSharedMocks {
  return {
    resolveConfigPath: vi.fn(() => `/tmp/openclaw-${configPathLabel}-missing-${process.pid}.json`),
    resolveGatewayPort: vi.fn((cfg?: OpenClawConfig) => cfg?.gateway?.port ?? 18789),
    hasConfiguredChannels: vi.fn(),
    hasConfiguredChannelsForReadOnlyScope: vi.fn(),
    readConfigFileSnapshotWithPluginMetadata: vi.fn<ReadConfigSnapshot>(),
    resolveCommandSecretRefsViaGateway: vi.fn(),
    getUpdateCheckResult: vi.fn(),
    getAgentLocalStatuses: vi.fn(),
    getStatusSummary: vi.fn(),
    getMemorySearchManager: vi.fn(),
    buildGatewayConnectionDetails: vi.fn(),
    resolveGatewayProbeTarget: vi.fn(() => ({
      mode: "local",
      gatewayMode: "local",
      remoteUrlMissing: false,
    })),
    probeGateway: vi.fn(),
    resolveGatewayProbeAuthResolution: vi.fn(),
    ensurePluginRegistryLoaded: vi.fn(),
    buildPluginCompatibilityNotices: vi.fn(() => []),
  };
}

type StatusOsSummaryModuleMock = {
  resolveOsSummary: Mock<() => { label: string }>;
};

function createStatusOsSummaryModuleMock(): StatusOsSummaryModuleMock {
  return {
    resolveOsSummary: vi.fn(() => ({ label: "test-os" })),
  };
}

type StatusScanDepsRuntimeModuleMock = Pick<
  typeof import("./status.scan.deps.runtime.js"),
  "getMemoryProvider" | "isMemoryProviderNative"
> & {
  getMemorySearchManager: StatusScanSharedMocks["getMemorySearchManager"];
};

function createStatusScanDepsRuntimeModuleMock(
  mocks: Pick<StatusScanSharedMocks, "getMemorySearchManager">,
): StatusScanDepsRuntimeModuleMock {
  return {
    getMemoryProvider: vi.fn<StatusScanDepsRuntimeModuleMock["getMemoryProvider"]>(async () => ({
      provider: null,
    })),
    getMemorySearchManager: mocks.getMemorySearchManager,
    isMemoryProviderNative: vi.fn<StatusScanDepsRuntimeModuleMock["isMemoryProviderNative"]>(
      () => false,
    ),
  };
}

type StatusGatewayProbeModuleMock = {
  resolveGatewayProbeAuthResolution: StatusScanSharedMocks["resolveGatewayProbeAuthResolution"];
};

function createStatusGatewayProbeModuleMock(
  mocks: Pick<StatusScanSharedMocks, "resolveGatewayProbeAuthResolution">,
): StatusGatewayProbeModuleMock {
  return {
    resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
  };
}

type StatusGatewayCallModuleMock = {
  buildGatewayConnectionDetails: StatusScanSharedMocks["buildGatewayConnectionDetails"];
  callGateway?: unknown;
};

function createStatusGatewayCallModuleMock(
  mocks: Pick<StatusScanSharedMocks, "buildGatewayConnectionDetails"> & {
    callGateway?: unknown;
  },
): StatusGatewayCallModuleMock {
  return {
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    ...(mocks.callGateway ? { callGateway: mocks.callGateway } : {}),
  };
}

function createStatusPluginRegistryModuleMock(
  mocks: Pick<StatusScanSharedMocks, "ensurePluginRegistryLoaded">,
): { ensurePluginRegistryLoaded: StatusScanSharedMocks["ensurePluginRegistryLoaded"] } {
  return {
    ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
  };
}

function createStatusPluginStatusModuleMock(
  mocks: Pick<StatusScanSharedMocks, "buildPluginCompatibilityNotices">,
): {
  buildPluginCompatibilityNotices: StatusScanSharedMocks["buildPluginCompatibilityNotices"];
  buildPluginCompatibilitySnapshotNotices: StatusScanSharedMocks["buildPluginCompatibilityNotices"];
} {
  return {
    buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
    buildPluginCompatibilitySnapshotNotices: mocks.buildPluginCompatibilityNotices,
  };
}

function createStatusUpdateModuleMock(mocks: Pick<StatusScanSharedMocks, "getUpdateCheckResult">): {
  getUpdateCheckResult: StatusScanSharedMocks["getUpdateCheckResult"];
} {
  return {
    getUpdateCheckResult: mocks.getUpdateCheckResult,
  };
}

function createStatusAgentLocalModuleMock(
  mocks: Pick<StatusScanSharedMocks, "getAgentLocalStatuses">,
): {
  collectStatusLocalSnapshot: (
    cfg: OpenClawConfig,
  ) => Promise<{ defaultId: string | null; publish: () => unknown; sessionStores: undefined }>;
} {
  return {
    collectStatusLocalSnapshot: async (cfg) => {
      const agentStatus = await mocks.getAgentLocalStatuses(cfg);
      return {
        defaultId: agentStatus.defaultId,
        publish: () => agentStatus,
        sessionStores: undefined,
      };
    },
  };
}

function createStatusSummaryModuleMock(mocks: Pick<StatusScanSharedMocks, "getStatusSummary">) {
  return {
    getStatusSummary: mocks.getStatusSummary,
    prepareStatusSummary: async (...args: unknown[]) => {
      const summary = await mocks.getStatusSummary(...args);
      return { publish: () => ({ summary, sessionStores: undefined }) };
    },
  };
}

function createStatusExecModuleMock(): { runExec: UnknownMock } {
  return {
    runExec: vi.fn(),
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
    hasConfiguredChannelsForReadOnlyScope: (params: {
      config: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includePersistedAuthState?: boolean;
    }) => mocks.hasConfiguredChannelsForReadOnlyScope(params),
    listConfiguredChannelIdsForReadOnlyScope: (params: {
      config: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includePersistedAuthState?: boolean;
    }) =>
      mocks.hasConfiguredChannels(
        params.config,
        params.env,
        params.includePersistedAuthState === undefined
          ? undefined
          : { includePersistedAuthState: params.includePersistedAuthState },
      )
        ? ["mock-channel"]
        : [],
  }));

  vi.doMock("../config/config.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../config/config.js")>()),
    readConfigFileSnapshotWithPluginMetadata: mocks.readConfigFileSnapshotWithPluginMetadata,
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
  vi.doMock("./status.update.js", () => createStatusUpdateModuleMock(mocks));
  vi.doMock("./status.agent-local.js", () => createStatusAgentLocalModuleMock(mocks));
  vi.doMock("../status/summary.js", () => createStatusSummaryModuleMock(mocks));
  vi.doMock("../infra/os-summary.js", () => createStatusOsSummaryModuleMock());
  vi.doMock("./status.scan.deps.runtime.js", () => createStatusScanDepsRuntimeModuleMock(mocks));
  vi.doMock("../gateway/call.js", () => createStatusGatewayCallModuleMock(mocks));
  vi.doMock("../gateway/probe.js", () => ({
    probeGateway: mocks.probeGateway,
  }));
  vi.doMock("../cli/daemon-cli/diagnostic-readiness.js", () => ({
    waitForGatewayDiagnosticReadiness: async () => undefined,
  }));
  vi.doMock("../gateway/probe-target.js", () => ({
    resolveGatewayProbeTarget: mocks.resolveGatewayProbeTarget,
  }));
  vi.doMock("./status.gateway-probe.js", () => createStatusGatewayProbeModuleMock(mocks));
  vi.doMock("../gateway/connection-details.js", () => ({
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    buildGatewayConnectionDetailsWithResolvers: mocks.buildGatewayConnectionDetails,
  }));
  vi.doMock("../process/exec.js", () => createStatusExecModuleMock());
  vi.doMock("../plugins/runtime/runtime-registry-loader.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../plugins/runtime/runtime-registry-loader.js")>()),
    ...createStatusPluginRegistryModuleMock(mocks),
  }));
  vi.doMock("../plugins/status.js", () => createStatusPluginStatusModuleMock(mocks));

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
    byAgent?: unknown[];
  } = {},
) {
  return {
    sessions: {
      count: 0,
      paths: [],
      defaults: {},
      recent: [],
      ...(Object.hasOwn(options, "byAgent") ? { byAgent: options.byAgent ?? [] } : {}),
    },
  };
}

function createStatusUpdateResult() {
  return {
    installKind: "git",
    git: null,
    registry: null,
  };
}

function createStatusAgentLocalStatuses() {
  return {
    defaultId: "main",
    agents: [],
  };
}

function createStatusGatewayConnection() {
  return {
    url: "ws://127.0.0.1:18789",
    urlSource: "default",
  };
}

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
    memoryManager?: ReturnType<typeof createStatusMemorySearchManager>;
  } = {},
) {
  const sourceConfig = options.sourceConfig ?? createStatusScanConfig();
  const resolvedConfig = options.resolvedConfig ?? sourceConfig;

  mocks.hasConfiguredChannels.mockReturnValue(options.hasConfiguredChannels ?? false);
  mocks.hasConfiguredChannelsForReadOnlyScope.mockImplementation((rawParams: unknown) => {
    const params = rawParams as {
      config: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
      includePersistedAuthState?: boolean;
    };
    return Boolean(
      mocks.hasConfiguredChannels(
        params.config,
        params.env,
        params.includePersistedAuthState === undefined
          ? undefined
          : { includePersistedAuthState: params.includePersistedAuthState },
      ),
    );
  });
  mocks.readConfigFileSnapshotWithPluginMetadata.mockResolvedValue({
    snapshot: {
      ...createTestConfigSnapshot(sourceConfig, sourceConfig, mocks.resolveConfigPath()),
      exists: false,
      raw: null,
      parsed: sourceConfig,
    },
  });
  mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig,
    diagnostics: [],
  });
  mocks.getAgentLocalStatuses.mockResolvedValue(createStatusAgentLocalStatuses());
  mocks.getStatusSummary.mockResolvedValue(options.summary ?? createStatusSummary());
  mocks.buildGatewayConnectionDetails.mockReturnValue(createStatusGatewayConnection());
  mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
    auth: {},
    warning: undefined,
  });
  mocks.ensurePluginRegistryLoaded.mockImplementation(() => {});
  mocks.buildPluginCompatibilityNotices.mockReturnValue([]);

  mocks.getUpdateCheckResult.mockResolvedValue(createStatusUpdateResult());
  mocks.probeGateway.mockResolvedValue(createStatusGatewayProbeFailure());

  if (options.memoryManager) {
    mocks.getMemorySearchManager.mockResolvedValue(options.memoryManager);
  }
}
