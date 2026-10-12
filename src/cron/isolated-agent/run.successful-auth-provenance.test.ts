import { describe, expect, it } from "vitest";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import {
  runInitialModelFallbackAttempt,
  runFallbackModelAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resolveAllowedModelRefMock,
  resolveCronSessionMock,
  resolveSessionAuthSelectionMock,
  runCliAgentMock,
  runEmbeddedAgentMock,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("cron successful-account provenance", () => {
  setupRunCronIsolatedAgentTurnSuite();
  it.each([
    {
      name: "earlier A then winning B",
      native: false,
      earlier: "openai:a",
      expectedSource: "resolved",
    },
    {
      name: "earlier B then unobserved native winner",
      native: true,
      earlier: "openai:b",
      expectedSource: "runtime",
    },
  ])(
    "persists only the winning candidate authority: $name",
    async ({ native, earlier, expectedSource }) => {
      const cronSession = makeCronSession({
        sessionEntry: makeCronSessionEntry({ authProfileOverride: "openai:a" }),
      });
      resolveCronSessionMock.mockReturnValue(cronSession);
      resolveSessionAuthSelectionMock.mockResolvedValue({ profileId: "openai:a", source: "user" });
      resolveAllowedModelRefMock.mockImplementation(({ raw }: { raw: string }) => {
        const [provider, model] = raw.split("/");
        return { ref: { provider, model } };
      });
      isCliProviderMock.mockImplementation((provider: string) => provider === "test-cli");
      let attempt = 0;
      runEmbeddedAgentMock.mockImplementation(
        async (request: Parameters<typeof runEmbeddedAgent>[0]) => {
          request.onSuccessfulAuthProfile?.(attempt++ === 0 ? earlier : "openai:b");
          return {
            payloads: [{ text: "done" }],
            meta: {
              durationMs: 1,
              agentMeta: {
                sessionId: cronSession.sessionEntry.sessionId,
                provider: request.provider,
                model: request.model,
                agentHarnessId: "openclaw",
                contextTokens: 900_000,
                contextTokensSource: "runtime",
              },
            },
          };
        },
      );
      runCliAgentMock.mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: {
            sessionId: cronSession.sessionEntry.sessionId,
            provider: "test-cli",
            model: "winner",
            agentHarnessId: "codex",
            contextTokens: 900_000,
            contextTokensSource: "runtime",
          },
        },
      });
      const winnerProvider = native ? "test-cli" : "openai";
      runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => {
        await runInitialModelFallbackAttempt(params);
        const result = await runFallbackModelAttempt(params, winnerProvider, "winner", "unknown");
        return { result, provider: winnerProvider, model: "winner", attempts: [] };
      });
      await runCronIsolatedAgentTurn(
        makeIsolatedAgentParamsFixture({
          sessionKey: "cron:auth-provenance",
          job: makeIsolatedAgentJobFixture({
            id: "auth-provenance-job",
            payload: { kind: "agentTurn", message: "pong", model: "openai/initial" },
          }),
        }),
      );
      expect(cronSession.sessionEntry).toMatchObject({
        contextTokens: 900_000,
        contextTokensSource: expectedSource,
      });
    },
  );
});
