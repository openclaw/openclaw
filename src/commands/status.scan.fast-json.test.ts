import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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
    totalSessions: 0,
    bootstrapPendingCount: 0,
  });
  mocks.getStatusSummary.mockResolvedValue({
    linkChannel: undefined,
    sessions: { count: 0, paths: [], defaults: {}, recent: [], byAgent: [] },
  });
  mocks.buildGatewayConnectionDetails.mockReturnValue({
    url: "ws://127.0.0.1:18789",
    urlSource: "default",
  });
  mocks.resolveGatewayProbeAuthResolution.mockReturnValue({
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

  it("skips heavy status summary loading on the missing-config fast path", async () => {
    const previous = {
      VITEST: process.env.VITEST,
      VITEST_POOL_ID: process.env.VITEST_POOL_ID,
      NODE_ENV: process.env.NODE_ENV,
      OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
      OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
      CLAWDBOT_STATE_DIR: process.env.CLAWDBOT_STATE_DIR,
      CLAWDBOT_CONFIG_PATH: process.env.CLAWDBOT_CONFIG_PATH,
    };
    const tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-status-fast-"));

    try {
      delete process.env.VITEST;
      delete process.env.VITEST_POOL_ID;
      delete process.env.NODE_ENV;
      delete process.env.OPENCLAW_CONFIG_PATH;
      delete process.env.CLAWDBOT_STATE_DIR;
      delete process.env.CLAWDBOT_CONFIG_PATH;
      process.env.OPENCLAW_STATE_DIR = tmpStateDir;

      const result = await scanStatusJsonFast({}, {} as never);

      expect(mocks.readBestEffortConfig).not.toHaveBeenCalled();
      expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
      expect(mocks.getStatusSummary).not.toHaveBeenCalled();
      expect(result.summary).toEqual(
        expect.objectContaining({
          heartbeat: expect.objectContaining({ defaultAgentId: "main", agents: [] }),
          channelSummary: [],
          queuedSystemEvents: [],
          sessions: expect.objectContaining({
            count: 0,
            defaults: { model: null, contextTokens: null },
            recent: [],
            byAgent: [],
          }),
        }),
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await fs.rm(tmpStateDir, { recursive: true, force: true });
    }
  });
});
