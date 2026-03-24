import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";

export function createStatusScanSharedMocks(configPathLabel: string) {
  return {
    resolveConfigPath: vi.fn(() => `/tmp/openclaw-${configPathLabel}-missing-${process.pid}.json`),
    hasPotentialConfiguredChannels: vi.fn(),
    readBestEffortConfig: vi.fn(),
    resolveCommandSecretRefsViaGateway: vi.fn(),
    getUpdateCheckResult: vi.fn(),
    getAgentLocalStatuses: vi.fn(),
    getStatusSummary: vi.fn(),
    getMemorySearchManager: vi.fn(),
    buildGatewayConnectionDetails: vi.fn(),
    probeGateway: vi.fn(),
    resolveGatewayProbeAuthResolution: vi.fn(),
    ensurePluginRegistryLoaded: vi.fn(),
    buildPluginCompatibilityNotices: vi.fn(() => []),
  };
}

export type StatusScanSharedMocks = ReturnType<typeof createStatusScanSharedMocks>;

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
      ...(Object.prototype.hasOwnProperty.call(options, "byAgent")
        ? { byAgent: options.byAgent ?? [] }
        : {}),
    },
  };
}

export function createStatusUpdateResult() {
  return {
    installKind: "git",
    git: null,
    registry: null,
  };
}

export function createStatusAgentLocalStatuses() {
  return {
    defaultId: "main",
    agents: [],
  };
}

export function createStatusGatewayConnection() {
  return {
    url: "ws://127.0.0.1:18789",
    urlSource: "default",
  };
}

export function createStatusGatewayProbeFailure() {
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
    agents: {
      defaults: {
        memorySearch: {
          provider: "local",
          local: { modelPath: "/tmp/model.gguf" },
          fallback: "none",
        },
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

  mocks.hasPotentialConfiguredChannels.mockReturnValue(options.hasConfiguredChannels ?? false);
  mocks.readBestEffortConfig.mockResolvedValue(sourceConfig);
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
  const previousEntries = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previousEntries)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
