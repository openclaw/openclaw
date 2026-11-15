import { beforeEach, expect, it } from "vitest";
import {
  makeIsolatedAgentJobFixture,
  makeIsolatedAgentParamsFixture,
} from "./isolated-agent/job-fixtures.js";
import {
  loadRunCronIsolatedAgentTurn,
  logWarnMock,
  makeCronSession,
  makeCronSessionEntry,
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
const reason = "local provider preflight failed";
const fallback = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";
const primary = { provider: "ollama", model: "qwen3:32b" };
function runPreflight(strict: boolean) {
  const model = {
    primary: "ollama/qwen3:32b@ollama:test-profile",
    fallbacks: [fallback, "openai/gpt-5.4"],
  };
  const providers = {
    ollama: { api: "ollama", baseUrl: "http://127.0.0.1:11434", models: [] },
    openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [] },
  };
  return runCronIsolatedAgentTurn(
    makeIsolatedAgentParamsFixture({
      cfg: {
        agents: { defaults: { model } },
        auth: { profiles: { "ollama:test-profile": { provider: "ollama", mode: "token" } } },
        models: { providers },
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

beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  resolveConfiguredModelRefMock.mockReturnValue({ ...primary });
  resolveCronSessionMock.mockReturnValue(
    makeCronSession({ sessionEntry: makeCronSessionEntry({ sessionId: "cron-session" }) }),
  );
  preflightCronModelProviderMock.mockResolvedValueOnce({ status: "unavailable", reason });
});

it("continues with a reachable fallback and drops the unavailable model's auth profile", async () => {
  mockRunCronFallbackPassthrough();
  const result = await runPreflight(false);
  const selected = { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" };
  expect(result).toMatchObject({ status: "ok", ...selected });
  expect(preflightCronModelProviderMock.mock.calls.map((call) => call[0])).toMatchObject([
    primary,
    selected,
  ]);
  expect(runEmbeddedAgentMock.mock.calls[0]?.[0]).toMatchObject(selected);
  expect(runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
    fallbacksOverride: ["openai/gpt-5.4"],
  });
  expect(resolveSessionAuthSelectionMock.mock.calls[0]?.[0]).not.toHaveProperty(
    "configuredProfileId",
  );
  const warning = String(logWarnMock.mock.calls[0]?.[0] ?? "");
  expect(warning).toContain(reason);
  expect(warning).toContain(`continuing with fallback ${fallback}`);
  expect(warning).not.toContain("Skipping this cron run");
});

it("keeps explicit empty payload fallbacks strict when the primary is unavailable", async () => {
  const result = await runPreflight(true);
  expect(result).toMatchObject({ status: "skipped", ...primary, sessionId: "cron-session" });
  expect(result.error).toContain(reason);
  expect(preflightCronModelProviderMock).toHaveBeenCalledOnce();
  expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
});
