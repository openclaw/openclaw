import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe,
  resolveStatusRuntimeSnapshot,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import { createStatusGatewayProbeBudget } from "./status.gateway-probe-budget.js";

const mocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn(),
  runSecurityAudit: vi.fn(),
  callGateway: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  resolveModelAuthLabelAsync: vi.fn(),
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

// mock-isolation: Usage status uses fixture auth labels without loading host profiles or CLI keys.
vi.mock("../agents/model-auth-label.js", () => ({
  resolveModelAuthLabelAsync: mocks.resolveModelAuthLabelAsync,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

function usageParams(runtime: "codex" | "openclaw" = "codex") {
  return {
    ...createStatusGatewayProbeBudget(3456),
    config: {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: { "openai/gpt-5.5": { agentRuntime: { id: runtime } } },
        },
      },
    } satisfies OpenClawConfig,
    agentDir: "/tmp/status-agent",
  };
}

function gatewayParams(timeoutMs = 4321) {
  return {
    config: { gateway: {} },
    ...createStatusGatewayProbeBudget(timeoutMs),
    gatewayReachable: true,
  };
}

function snapshot(overrides: Partial<Parameters<typeof resolveStatusRuntimeSnapshot>[0]> = {}) {
  return resolveStatusRuntimeSnapshot({
    ...createStatusGatewayProbeBudget(),
    config: { gateway: {} },
    sourceConfig: { gateway: {} },
    deep: true,
    gatewayReachable: true,
    ...overrides,
  });
}

function anthropicUsage() {
  return { provider: "anthropic", displayName: "Claude", windows: [], error: "HTTP 429" };
}
function openaiUsage(usedPercent?: number) {
  return {
    provider: "openai",
    displayName: "OpenAI",
    windows: usedPercent === undefined ? [] : [{ label: "5h", usedPercent }],
  };
}

describe("status-runtime-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.runSecurityAudit.mockResolvedValue({ summary: { critical: 0 }, findings: [] });
    mocks.callGateway.mockResolvedValue({ ok: true });
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "node" });
    mocks.resolveModelAuthLabelAsync.mockReturnValue(undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses the named system agent for agent-scoped usage credentials", async () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        defaults: { systemAgent: { agentId: "ops" } },
        entries: {
          main: { agentDir: "/tmp/status-main-agent" },
          ops: { agentDir: "/tmp/status-ops-agent" },
        },
      },
    };

    await resolveStatusUsageSummary({ ...createStatusGatewayProbeBudget(), config });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      timeoutMs: 60_000,
      config,
      agentDir: "/tmp/status-ops-agent",
    });
  });

  it.each([
    [undefined, "Set agents.defaults.systemAgent.agentId"],
    ["ghost", 'Unknown agent id "ghost"'],
  ] as const)("rejects ambiguous or unknown explicit usage owner %s", async (agentId, error) => {
    await expect(
      resolveStatusUsageSummary({
        ...createStatusGatewayProbeBudget(),
        config: { agents: { ownership: "explicit", entries: { main: {}, ops: {} } } },
        agentId,
      }),
    ).rejects.toThrow(error);
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
  });

  it("shares the usage deadline with Codex synthetic usage", async () => {
    mocks.loadProviderUsageSummary
      .mockImplementationOnce(async () => {
        vi.spyOn(performance, "now").mockReturnValue(3456);
        return {
          updatedAt: 1,
          providers: [anthropicUsage()],
        };
      })
      .mockResolvedValueOnce({
        updatedAt: 2,
        providers: [openaiUsage(9)],
      });

    await expect(resolveStatusUsageSummary(usageParams())).resolves.toEqual({
      updatedAt: 1,
      providers: [anthropicUsage(), openaiUsage(9)],
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenNthCalledWith(2, {
      timeoutMs: 0,
      providers: ["openai"],
      auth: [
        {
          provider: "openai",
          token: "codex-app-server",
          hookProvider: "codex",
        },
      ],
      config: expect.any(Object),
      agentDir: "/tmp/status-agent",
    });
  });

  it("keeps existing OpenAI usage when Codex synthetic usage has no windows", async () => {
    mocks.loadProviderUsageSummary
      .mockResolvedValueOnce({
        updatedAt: 1,
        providers: [openaiUsage(22)],
      })
      .mockResolvedValueOnce({
        updatedAt: 2,
        providers: [openaiUsage()],
      });

    await expect(resolveStatusUsageSummary(usageParams())).resolves.toEqual({
      updatedAt: 1,
      providers: [openaiUsage(22)],
    });
  });

  it("does not add Codex synthetic usage for OpenAI routes pinned to OpenClaw runtime", async () => {
    await resolveStatusUsageSummary(usageParams("openclaw"));

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    expect(mocks.loadProviderUsageSummary.mock.calls[0]?.[0]).not.toHaveProperty("auth");
  });

  it("does not add Codex synthetic usage for API-key-backed OpenAI Codex runtime routes", async () => {
    mocks.resolveModelAuthLabelAsync.mockReturnValue("api-key (openai:api)");

    await resolveStatusUsageSummary(usageParams());

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    expect(mocks.loadProviderUsageSummary.mock.calls[0]?.[0]).not.toHaveProperty("auth");
    expect(mocks.resolveModelAuthLabelAsync).toHaveBeenCalledWith({
      provider: "openai",
      acceptedProviderIds: ["openai"],
      cfg: expect.any(Object),
      agentDir: "/tmp/status-agent",
      includeExternalProfiles: false,
    });
  });

  it("resolves usage auth from an explicitly selected agent", async () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          alpha: { agentDir: "/tmp/alpha-agent" },
          beta: { agentDir: "/tmp/beta-agent" },
        },
      },
    };

    await resolveStatusRuntimeSnapshot({
      ...createStatusGatewayProbeBudget(2345),
      config,
      sourceConfig: config,
      agentId: "beta",
      usage: true,
      gatewayReachable: false,
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      timeoutMs: 2345,
      config,
      agentDir: "/tmp/beta-agent",
    });
  });

  it("returns a fallback health error when the gateway is unreachable", async () => {
    await expect(
      resolveStatusGatewayHealthSafe({
        ...createStatusGatewayProbeBudget(),
        config: { gateway: {} },
        gatewayReachable: false,
        gatewayProbeError: "timeout",
      }),
    ).resolves.toEqual({ error: "timeout" });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("passes gateway call overrides through the safe health path", async () => {
    await resolveStatusGatewayHealthSafe({
      ...gatewayParams(),
      callOverrides: {
        url: "ws://127.0.0.1:18789",
        token: "tok",
      },
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      params: { probe: true },
      timeoutMs: 4321,
      config: { gateway: {} },
      url: "ws://127.0.0.1:18789",
      token: "tok",
    });
  });

  it("requests the typed exporter stability projection", async () => {
    await expect(
      resolveStatusGatewayDiagnosticsSafe({
        ...gatewayParams(),
        type: "telemetry.exporter",
      }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "diagnostics.stability",
      params: { limit: 1000, type: "telemetry.exporter" },
      timeoutMs: 4321,
      config: { gateway: {} },
    });
  });

  it("preserves failed gateway diagnostics as a typed result", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("diagnostics probe timed out"));

    await expect(resolveStatusGatewayDiagnosticsSafe(gatewayParams())).resolves.toEqual({
      ok: false,
      error: "Error: diagnostics probe timed out",
    });
  });

  it("resolves the shared runtime snapshot with security audit and runtime details", async () => {
    await expect(
      snapshot({
        sourceConfig: { gateway: { mode: "local" } },
        ...createStatusGatewayProbeBudget(1234),
        usage: true,
        includeSecurityAudit: true,
      }),
    ).resolves.toEqual({
      securityAudit: { summary: { critical: 0 }, findings: [] },
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { ok: true },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      params: { probe: true },
      timeoutMs: 1234,
      config: { gateway: {} },
    });
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: { mode: "local" } },
      deep: false,
      deepTimeoutMs: 1234,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });
  });

  it("keeps failed deep health probes visible in nonthrowing status snapshots", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway health probe timed out"));

    await expect(
      snapshot({
        suppressHealthErrors: true,
      }),
    ).resolves.toMatchObject({
      health: { error: "Error: gateway health probe timed out" },
      lastHeartbeat: { ok: true },
    });
  });

  it("shares the readiness deadline with deep health and skips heartbeat when it expires", async () => {
    mocks.callGateway.mockImplementation(async () => {
      vi.spyOn(performance, "now").mockReturnValue(38_000);
      return { ok: true };
    });
    const result = await snapshot({
      config: {},
      sourceConfig: {},
      gatewayProbeDeadlineMs: 38_000,
    });

    expect(result.health).toEqual({ ok: true });
    expect(result.lastHeartbeat).toBeNull();
    expect(mocks.callGateway).toHaveBeenCalledExactlyOnceWith({
      method: "health",
      params: { probe: true },
      config: {},
      timeoutMs: 38_000,
    });
  });

  it("uses the completed initial probe for deep health", async () => {
    const result = await snapshot({
      config: {},
      sourceConfig: {},
      gatewayReachable: false,
      gatewayProbeError: "connection refused",
      suppressHealthErrors: true,
    });

    expect(result).toMatchObject({ health: { error: "connection refused" }, lastHeartbeat: null });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });
});
