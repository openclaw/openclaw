// Isolated agent model preflight tests cover model readiness checks before cron runs.
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  preflightCronModelProviderMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn model provider preflight", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({
      provider: "ollama",
      model: "qwen3:32b",
    });
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "cron-session",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
        },
      }),
    );
  });

  it("skips isolated cron execution when the local model provider is unavailable", async () => {
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason:
        "Agent cron job uses ollama/qwen3:32b but the local provider endpoint is not reachable at http://127.0.0.1:11434.",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: [],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "dead-ollama",
        name: "Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:dead-ollama",
      lane: "cron",
    });

    expect(result.status).toBe("skipped");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3:32b");
    expect(result.sessionId).toBe("cron-session");
    expect(result.error).toContain("local provider endpoint is not reachable");
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });

  it("continues with configured fallback when the local primary preflight is unavailable", async () => {
    mockRunCronFallbackPassthrough();
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason:
        "Agent cron job uses ollama/qwen3:32b but the local provider endpoint is not reachable at http://127.0.0.1:11434.",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-5.4"],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "fallback-from-dead-ollama",
        name: "Fallback From Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:fallback-from-dead-ollama",
      lane: "cron",
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(preflightCronModelProviderMock.mock.calls.map((call) => call[0])).toMatchObject([
      { provider: "ollama", model: "qwen3:32b" },
      { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" },
    ]);
    expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
    });
    expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      fallbacksOverride: ["openai/gpt-5.4"],
    });
    expect(String(logWarnMock.mock.calls[0]?.[0] ?? "")).toContain(
      "continuing with fallback openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    );
    expect(String(logWarnMock.mock.calls[0]?.[0] ?? "")).not.toContain("Skipping this cron run");
  });

  it("shares one preflight deadline across multiple local fallback candidates", async () => {
    mockRunCronFallbackPassthrough();
    preflightCronModelProviderMock
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "first local provider unavailable",
        provider: "ollama",
        model: "qwen3:32b",
        baseUrl: "http://127.0.0.1:11434",
        retryAfterMs: 300000,
      })
      .mockResolvedValueOnce({
        status: "unavailable",
        reason: "second local provider unavailable",
        provider: "vllm",
        model: "local-fallback",
        baseUrl: "http://127.0.0.1:8000/v1",
        retryAfterMs: 300000,
      })
      .mockResolvedValueOnce({ status: "available" });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: ["vllm/local-fallback", "openrouter/cloud-fallback"],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
            vllm: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [],
            },
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "shared-preflight-budget",
        name: "Shared Preflight Budget",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:shared-preflight-budget",
      lane: "cron",
    });

    expect(result.status).toBe("ok");
    expect(result.provider).toBe("openrouter");
    const preflightCalls = preflightCronModelProviderMock.mock.calls.map((call) => call[0]);
    expect(preflightCalls).toMatchObject([
      { provider: "ollama", model: "qwen3:32b" },
      { provider: "vllm", model: "local-fallback" },
      { provider: "openrouter", model: "openrouter/cloud-fallback" },
    ]);
    const deadlines = preflightCalls.map((call) => call.deadlineMs);
    expect(deadlines.every((deadline) => typeof deadline === "number")).toBe(true);
    expect(new Set(deadlines).size).toBe(1);
  });

  it("keeps explicit empty payload fallbacks strict when local primary preflight fails", async () => {
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason:
        "Agent cron job uses ollama/qwen3:32b but the local provider endpoint is not reachable at http://127.0.0.1:11434.",
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });

    const result = await runCronIsolatedAgentTurn({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b",
              fallbacks: ["openrouter/nvidia/nemotron-3-super-120b-a12b:free"],
            },
          },
        },
        models: {
          providers: {
            ollama: {
              api: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              models: [],
            },
          },
        },
      },
      deps: {} as never,
      job: {
        id: "strict-dead-ollama",
        name: "Strict Dead Ollama",
        enabled: true,
        createdAtMs: 0,
        updatedAtMs: 0,
        schedule: { kind: "cron", expr: "*/5 * * * *", tz: "UTC" },
        sessionTarget: "isolated",
        state: {},
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "summarize", fallbacks: [] },
        delivery: { mode: "none" },
      },
      message: "summarize",
      sessionKey: "cron:strict-dead-ollama",
      lane: "cron",
    });

    expect(result.status).toBe("skipped");
    expect(preflightCronModelProviderMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});
