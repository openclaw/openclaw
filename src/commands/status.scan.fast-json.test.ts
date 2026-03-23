import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveConfigPath: vi.fn(() => `/tmp/openclaw-status-fast-json-missing-${process.pid}.json`),
  hasPotentialConfiguredChannels: vi.fn(),
  readBestEffortConfig: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getStatusCommandSecretTargetIds: vi.fn(() => []),
  getUpdateCheckResult: vi.fn(),
  getAgentLocalStatuses: vi.fn(),
  getStatusSummary: vi.fn(),
  resolveMemorySearchConfig: vi.fn(),
  getMemorySearchManager: vi.fn(),
  buildGatewayConnectionDetails: vi.fn(),
  probeGateway: vi.fn(),
  resolveGatewayProbeAuthResolution: vi.fn(),
  ensurePluginRegistryLoaded: vi.fn(),
  buildPluginCompatibilityNotices: vi.fn(() => []),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasPotentialConfiguredChannels.mockReturnValue(false);
  mocks.readBestEffortConfig.mockResolvedValue({
    session: {},
    gateway: {},
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
  mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
    resolvedConfig: {
      session: {},
      gateway: {},
      agents: {
        defaults: {
          memorySearch: {
            provider: "local",
            local: { modelPath: "/tmp/model.gguf" },
            fallback: "none",
          },
        },
      },
    },
    diagnostics: [],
  });
  mocks.getUpdateCheckResult.mockResolvedValue({
    installKind: "git",
    git: null,
    registry: null,
  });
  mocks.getAgentLocalStatuses.mockResolvedValue({
    defaultId: "main",
    agents: [],
  });
  mocks.getStatusSummary.mockResolvedValue({
    linkChannel: undefined,
    sessions: { count: 0, paths: [], defaults: {}, recent: [], byAgent: [] },
  });
  mocks.buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "default",
  });
  mocks.resolveGatewayProbeAuthResolution.mockResolvedValue({
    auth: {},
    warning: undefined,
  });
  mocks.probeGateway.mockResolvedValue({
    ok: false,
    url: "ws://127.0.0.1:18789",
    connectLatencyMs: null,
    error: "timeout",
    close: null,
    health: null,
    status: null,
    presence: null,
    configSnapshot: null,
  });
  mocks.resolveMemorySearchConfig.mockReturnValue({
    store: { path: "/tmp/main.sqlite" },
  });
  mocks.getMemorySearchManager.mockResolvedValue({
    manager: {
      probeVectorAvailability: vi.fn(async () => true),
      status: vi.fn(() => ({ files: 0, chunks: 0, dirty: false })),
      close: vi.fn(async () => {}),
    },
  });
});

vi.mock("../channels/config-presence.js", () => ({
  hasPotentialConfiguredChannels: mocks.hasPotentialConfiguredChannels,
}));

vi.mock("../config/io.js", () => ({
  readBestEffortConfig: mocks.readBestEffortConfig,
}));

vi.mock("../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/paths.js")>();
  return {
    ...actual,
    resolveConfigPath: mocks.resolveConfigPath,
  };
});

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getStatusCommandSecretTargetIds: mocks.getStatusCommandSecretTargetIds,
}));

vi.mock("./status.update.js", () => ({
  getUpdateCheckResult: mocks.getUpdateCheckResult,
}));

vi.mock("./status.agent-local.js", () => ({
  getAgentLocalStatuses: mocks.getAgentLocalStatuses,
}));

vi.mock("./status.summary.js", () => ({
  getStatusSummary: mocks.getStatusSummary,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveOsSummary: vi.fn(() => ({ label: "test-os" })),
}));

vi.mock("./status.scan.deps.runtime.js", () => ({
  getTailnetHostname: vi.fn(),
  getMemorySearchManager: mocks.getMemorySearchManager,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig: mocks.resolveMemorySearchConfig,
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
}));

vi.mock("../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));

vi.mock("./status.gateway-probe.js", () => ({
  pickGatewaySelfPresence: vi.fn(() => null),
  resolveGatewayProbeAuthResolution: mocks.resolveGatewayProbeAuthResolution,
}));

vi.mock("../process/exec.js", () => ({
  runExec: vi.fn(),
}));

vi.mock("../cli/plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: mocks.ensurePluginRegistryLoaded,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityNotices: mocks.buildPluginCompatibilityNotices,
}));

const { scanStatusJsonFast } = await import("./status.scan.fast-json.js");

describe("scanStatusJsonFast", () => {
  it("skips memory inspection for the lean status --json fast path", async () => {
    const result = await scanStatusJsonFast({}, {} as never);

    expect(result.memory).toBeNull();
    expect(mocks.resolveMemorySearchConfig).not.toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).not.toHaveBeenCalled();
  });

  it("restores memory inspection when --all is requested", async () => {
    const result = await scanStatusJsonFast({ all: true }, {} as never);

    expect(result.memory).toEqual(expect.objectContaining({ agentId: "main" }));
    expect(mocks.resolveMemorySearchConfig).toHaveBeenCalled();
    expect(mocks.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            memorySearch: expect.any(Object),
          }),
        }),
      }),
      agentId: "main",
      purpose: "status",
    });
  });

  it("skips gateway and update probes on cold-start status --json", async () => {
    const originalVitest = process.env.VITEST;
    const originalVitestPoolId = process.env.VITEST_POOL_ID;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.VITEST_POOL_ID;
    delete process.env.NODE_ENV;
    try {
      await scanStatusJsonFast({}, {} as never);
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      if (originalVitestPoolId === undefined) {
        delete process.env.VITEST_POOL_ID;
      } else {
        process.env.VITEST_POOL_ID = originalVitestPoolId;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }

    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });
});
