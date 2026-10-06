import { beforeEach, describe, expect, it } from "vitest";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  preflightCronModelProviderMock,
  resolveConfiguredModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./isolated-agent/run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const unavailableReason = "local provider preflight failed";
const fallback = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
function runPreflight(strict: boolean) {
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "ollama/qwen3:32b@ollama:test-profile",
              fallbacks: [fallback, "openai/gpt-5.4"],
            },
          },
        },
        auth: { profiles: { "ollama:test-profile": { provider: "ollama", mode: "token" } } },
        models: {
          providers: {
            ollama: { api: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] },
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      },
      job: makeIsolatedAgentJobFixture({
        payload: { kind: "agentTurn", message: "summarize", ...(strict ? { fallbacks: [] } : {}) },
        delivery: { mode: "none" },
      }),
      message: "summarize",
      sessionKey: "cron:dead-ollama",
      lane: "cron",
    }),
  );
}

describe("cron model provider preflight", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "ollama", model: "qwen3:32b" });
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
    preflightCronModelProviderMock.mockResolvedValueOnce({
      status: "unavailable",
      reason: unavailableReason,
      provider: "ollama",
      model: "qwen3:32b",
      baseUrl: "http://127.0.0.1:11434",
      retryAfterMs: 300000,
    });
  });

  it("continues with a reachable fallback and drops the unavailable model's auth profile", async () => {
    mockRunCronFallbackPassthrough();
    const result = await runPreflight(false);
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
    expect(resolveSessionAuthSelectionMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "configuredProfileId",
    );
    const warning = String(logWarnMock.mock.calls[0]?.[0] ?? "");
    expect(warning).toContain(unavailableReason);
    expect(warning).toContain(`continuing with fallback ${fallback}`);
    expect(warning).not.toContain("Skipping this cron run");
  });

  it("keeps explicit empty payload fallbacks strict when the primary is unavailable", async () => {
    const result = await runPreflight(true);
    expect(result).toMatchObject({
      status: "skipped",
      provider: "ollama",
      model: "qwen3:32b",
      sessionId: "cron-session",
    });
    expect(result.error).toContain(unavailableReason);
    expect(preflightCronModelProviderMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
  });
});
