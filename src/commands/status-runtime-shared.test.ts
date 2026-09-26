// Status runtime shared tests cover gateway health, runtime details, and safe status probe fallbacks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  resolveModelAuthLabel: vi.fn(),
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: mocks.resolveModelAuthLabel,
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

function requireProviderUsageCall(): {
  timeoutMs?: number;
  config?: unknown;
  agentDir?: string;
  providers?: string[];
  auth?: Array<Record<string, unknown>>;
} {
  const call = mocks.loadProviderUsageSummary.mock.calls[0];
  if (!call) {
    throw new Error("expected provider usage summary call");
  }
  const params = call.at(0);
  if (!params || typeof params !== "object") {
    throw new Error("expected provider usage summary params");
  }
  return params as {
    timeoutMs?: number;
    config?: unknown;
    agentDir?: string;
    providers?: string[];
    auth?: Array<Record<string, unknown>>;
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
    mocks.resolveModelAuthLabel.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the remaining status budget through to provider usage", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(22_000);
    try {
      await resolveStatusRuntimeSnapshot({
        config: { gateway: {} },
        sourceConfig: { gateway: {} },
        usage: true,
        gatewayReachable: true,
        gatewayProbeDeadlineMs: 60_000,
      });

      const usageCall = requireProviderUsageCall();
      expect(usageCall.timeoutMs).toBe(38_000);
      expect(usageCall.config).toEqual({ gateway: {} });
      expect(usageCall.agentDir).toContain("main");
    } finally {
      clock.mockRestore();
    }
  });

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

  it("requires a system owner for usage credentials in an explicit multi-agent roster", async () => {
    await expect(
      resolveStatusUsageSummary({
        ...createStatusGatewayProbeBudget(),
        config: {
          agents: {
            ownership: "explicit",
            entries: { main: {}, ops: {} },
          },
        },
      }),
    ).rejects.toThrow("Set agents.defaults.systemAgent.agentId");
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
  });

  it.each([
    { elapsedMs: 2000, remainingMs: 1456 },
    { elapsedMs: 3456, remainingMs: 0 },
  ])(
    "shares the usage deadline with Codex synthetic usage ($elapsedMs ms spent)",
    async ({ elapsedMs, remainingMs }) => {
      mocks.loadProviderUsageSummary
        .mockImplementationOnce(async () => {
          vi.spyOn(performance, "now").mockReturnValue(elapsedMs);
          return {
            updatedAt: 1,
            providers: [
              {
                provider: "anthropic",
                displayName: "Claude",
                windows: [],
                error: "HTTP 429",
              },
            ],
          };
        })
        .mockResolvedValueOnce({
          updatedAt: 2,
          providers: [
            {
              provider: "openai",
              displayName: "OpenAI",
              windows: [{ label: "5h", usedPercent: 9 }],
            },
          ],
        });

      await expect(
        resolveStatusUsageSummary({
          ...createStatusGatewayProbeBudget(3456),
          config: {
            agents: {
              defaults: {
                model: { primary: "openai/gpt-5.5" },
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
                },
              },
            },
          },
          agentDir: "/tmp/status-agent",
        }),
      ).resolves.toEqual({
        updatedAt: 1,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            windows: [],
            error: "HTTP 429",
          },
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 9 }],
          },
        ],
      });

      expect(mocks.loadProviderUsageSummary).toHaveBeenNthCalledWith(2, {
        timeoutMs: remainingMs,
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
    },
  );

  it("keeps existing OpenAI usage when Codex synthetic usage has no windows", async () => {
    mocks.loadProviderUsageSummary
      .mockResolvedValueOnce({
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 22 }],
          },
        ],
      })
      .mockResolvedValueOnce({
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [],
          },
        ],
      });

    await expect(
      resolveStatusUsageSummary({
        ...createStatusGatewayProbeBudget(3456),
        config: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
        agentDir: "/tmp/status-agent",
      }),
    ).resolves.toEqual({
      updatedAt: 1,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 22 }],
        },
      ],
    });
  });

  it("does not add Codex synthetic usage for OpenAI routes pinned to OpenClaw runtime", async () => {
    await resolveStatusUsageSummary({
      ...createStatusGatewayProbeBudget(3456),
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    expect(requireProviderUsageCall()).not.toHaveProperty("auth");
  });

  it("does not add Codex synthetic usage for API-key-backed OpenAI Codex runtime routes", async () => {
    mocks.resolveModelAuthLabel.mockReturnValue("api-key (openai:api)");

    await resolveStatusUsageSummary({
      ...createStatusGatewayProbeBudget(3456),
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    expect(requireProviderUsageCall()).not.toHaveProperty("auth");
    expect(mocks.resolveModelAuthLabel).toHaveBeenCalledWith({
      provider: "openai",
      acceptedProviderIds: ["openai"],
      cfg: expect.any(Object),
      agentDir: "/tmp/status-agent",
      includeExternalProfiles: false,
    });
  });

  it("resolves usage summaries with explicit agent scope", async () => {
    await resolveStatusUsageSummary({
      ...createStatusGatewayProbeBudget(2345),
      config: { gateway: {} },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      timeoutMs: 2345,
      config: { gateway: {} },
      agentDir: "/tmp/status-agent",
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

    await resolveStatusUsageSummary({
      ...createStatusGatewayProbeBudget(2345),
      config,
      agentId: "beta",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      timeoutMs: 2345,
      config,
      agentDir: "/tmp/beta-agent",
    });
  });

  it("rejects an unknown explicit usage owner", async () => {
    await expect(
      resolveStatusUsageSummary({
        ...createStatusGatewayProbeBudget(),
        config: {
          agents: {
            ownership: "explicit",
            entries: { alpha: {}, beta: {} },
          },
        },
        agentId: "ghost",
      }),
    ).rejects.toThrow('Unknown agent id "ghost"');
    expect(mocks.loadProviderUsageSummary).not.toHaveBeenCalled();
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
      config: { gateway: {} },
      ...createStatusGatewayProbeBudget(4321),
      gatewayReachable: true,
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
        config: { gateway: {} },
        ...createStatusGatewayProbeBudget(4321),
        gatewayReachable: true,
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

    await expect(
      resolveStatusGatewayDiagnosticsSafe({
        config: { gateway: {} },
        ...createStatusGatewayProbeBudget(4321),
        gatewayReachable: true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Error: diagnostics probe timed out",
    });
  });

  it("resolves the shared runtime snapshot with security audit and runtime details", async () => {
    await expect(
      resolveStatusRuntimeSnapshot({
        config: { gateway: {} },
        sourceConfig: { gateway: { mode: "local" } },
        ...createStatusGatewayProbeBudget(1234),
        usage: true,
        deep: true,
        gatewayReachable: true,
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

  it("threads the selected agent into usage resolution", async () => {
    const resolveUsage = vi.fn(async () => ({ updatedAt: 1, providers: [] }));

    await resolveStatusRuntimeSnapshot({
      ...createStatusGatewayProbeBudget(),
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
      agentId: "beta",
      usage: true,
      gatewayReachable: false,
      resolveUsage,
    });

    expect(resolveUsage).toHaveBeenCalledWith({
      config: { gateway: {} },
      agentId: "beta",
      timeoutMs: 60_000,
      gatewayProbeDeadlineMs: 60_000,
    });
  });

  it("keeps a stale child runtime from the gateway health probe", async () => {
    const childRuntime = {
      execPath: "/opt/homebrew/Cellar/node@24/24.20.0/bin/node",
      available: false,
    };
    mocks.callGateway.mockImplementation(async (request: { method?: string }) =>
      request.method === "health" ? { ok: true, childRuntime } : { ok: true },
    );

    await expect(
      resolveStatusRuntimeSnapshot({
        config: { gateway: {} },
        sourceConfig: { gateway: {} },
        ...createStatusGatewayProbeBudget(1234),
        deep: true,
        gatewayReachable: true,
      }),
    ).resolves.toMatchObject({
      health: { ok: true, childRuntime },
    });
  });

  it("keeps failed deep health probes visible in nonthrowing status snapshots", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway health probe timed out"));

    await expect(
      resolveStatusRuntimeSnapshot({
        ...createStatusGatewayProbeBudget(),
        config: { gateway: {} },
        sourceConfig: { gateway: {} },
        deep: true,
        gatewayReachable: true,
        suppressHealthErrors: true,
      }),
    ).resolves.toMatchObject({
      health: { error: "Error: gateway health probe timed out" },
      lastHeartbeat: { ok: true },
    });
  });

  it("shares the readiness deadline with deep health and skips heartbeat when it expires", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      mocks.callGateway.mockImplementation(async () => {
        clock.mockReturnValue(38_000);
        return { ok: true };
      });
      const result = await resolveStatusRuntimeSnapshot({
        config: {},
        sourceConfig: {},
        deep: true,
        gatewayReachable: true,
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
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    { gatewayStartupPhase: "plugins", health: undefined },
    { gatewayStartupPhase: undefined, health: { error: "connection refused" } },
  ])(
    "uses the completed initial probe for deep health ($gatewayStartupPhase)",
    async ({ gatewayStartupPhase, health }) => {
      const snapshot = await resolveStatusRuntimeSnapshot({
        ...createStatusGatewayProbeBudget(),
        config: {},
        sourceConfig: {},
        deep: true,
        gatewayReachable: false,
        gatewayStartupPhase,
        gatewayProbeError: "connection refused",
        suppressHealthErrors: true,
      });

      expect(snapshot.health).toEqual(health);
      expect(snapshot.lastHeartbeat).toBeNull();
      expect(mocks.callGateway).not.toHaveBeenCalled();
    },
  );

  it("does not suppress failed deep health probes for text status", async () => {
    mocks.callGateway.mockRejectedValueOnce(new Error("gateway health probe timed out"));

    await expect(
      resolveStatusRuntimeSnapshot({
        ...createStatusGatewayProbeBudget(),
        config: { gateway: {} },
        sourceConfig: { gateway: {} },
        deep: true,
        gatewayReachable: true,
      }),
    ).rejects.toThrow("gateway health probe timed out");
  });
});
