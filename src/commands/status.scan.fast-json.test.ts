import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../logging/state.js";
import {
  applyStatusScanDefaults,
  createStatusMemorySearchConfig,
  createStatusMemorySearchManager,
  createStatusSummary,
  withTemporaryEnv,
} from "./status.scan.test-helpers.js";

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

let originalForceStderr: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  originalForceStderr = loggingState.forceConsoleToStderr;
  loggingState.forceConsoleToStderr = false;
  applyStatusScanDefaults(mocks, {
    sourceConfig: createStatusMemorySearchConfig(),
    resolvedConfig: createStatusMemorySearchConfig(),
    summary: createStatusSummary({ byAgent: [] }),
    memoryManager: createStatusMemorySearchManager(),
  });
  mocks.getStatusCommandSecretTargetIds.mockReturnValue([]);
  mocks.resolveMemorySearchConfig.mockReturnValue({
    store: { path: "/tmp/main.sqlite" },
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

afterEach(() => {
  loggingState.forceConsoleToStderr = originalForceStderr;
});

describe("scanStatusJsonFast", () => {
  it("routes plugin logs to stderr during deferred plugin loading", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    let stderrDuringLoad = false;
    mocks.ensurePluginRegistryLoaded.mockImplementation(() => {
      stderrDuringLoad = loggingState.forceConsoleToStderr;
    });

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.ensurePluginRegistryLoaded).toHaveBeenCalled();
    expect(stderrDuringLoad).toBe(true);
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("skips plugin compatibility loading even when configured channels are present", async () => {
    mocks.hasPotentialConfiguredChannels.mockReturnValue(true);

    await scanStatusJsonFast({}, {} as never);

    expect(mocks.buildPluginCompatibilityNotices).not.toHaveBeenCalled();
  });

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
    await withTemporaryEnv(
      {
        VITEST: undefined,
        VITEST_POOL_ID: undefined,
        NODE_ENV: undefined,
      },
      async () => {
        await scanStatusJsonFast({}, {} as never);
      },
    );

    expect(mocks.getUpdateCheckResult).not.toHaveBeenCalled();
    expect(mocks.probeGateway).not.toHaveBeenCalled();
  });
});
