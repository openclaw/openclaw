import { describe, expect, it } from "vitest";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import { deriveSessionTotalTokens, type NormalizedUsage } from "../../agents/usage.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  deriveSessionTotalTokensMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

async function runUsageCase(
  usage: NormalizedUsage,
  lastCallUsage: NormalizedUsage,
  currentContextSnapshot?: { tokens: number | undefined },
) {
  const cronSession = makeCronSession();
  resolveCronSessionMock.mockReturnValue(cronSession);
  mockRunCronFallbackPassthrough();
  deriveSessionTotalTokensMock.mockImplementation(deriveSessionTotalTokens);
  runEmbeddedAgentMock.mockImplementationOnce((params: RunEmbeddedAgentInternalParams) => {
    if (currentContextSnapshot) {
      if (!params.agentId || !params.sessionKey) {
        throw new Error("Cron did not bind the accounting session");
      }
      params.onCompactionAccounting?.({
        kind: "durable",
        count: 1,
        currentContextSnapshot,
        target: {
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          storePath: cronSession.storePath,
          lifecycleRevision: cronSession.lifecycleRevision,
          activeWriterRunId: params.runId,
        },
      });
    }
    return {
      payloads: [{ text: "done" }],
      meta: { agentMeta: { usage, lastCallUsage } },
    };
  });
  const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());
  expect(result.status).toBe("ok");
  return { result, cronSession };
}

describe("runCronIsolatedAgentTurn usage accounting", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each([20_000, undefined])(
    "keeps terminal compaction context %s instead of older model usage",
    async (tokens) => {
      const usage = { input: 55_000, output: 1_000, cacheRead: 1_000 };
      const { cronSession } = await runUsageCase(usage, usage, { tokens });
      expect(cronSession.sessionEntry.totalTokens).toBe(tokens);
      expect(cronSession.sessionEntry.totalTokensFresh).toBe(tokens !== undefined);
    },
  );

  it("uses final-call usage for the stored session token snapshot", async () => {
    const { result, cronSession } = await runUsageCase(
      { input: 75000, output: 2000, total: 56000, cacheRead: 5000, cacheWrite: 0 },
      { input: 55000, output: 1000, cacheRead: 1000, cacheWrite: 0 },
    );
    expect(cronSession.sessionEntry.inputTokens).toBe(75000);
    expect(cronSession.sessionEntry.outputTokens).toBe(2000);
    expect(cronSession.sessionEntry.totalTokens).toBe(57000);
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(true);
    expect(result.usage).toEqual({
      input_tokens: 75000,
      output_tokens: 2000,
      total_tokens: 82000,
      cache_read_tokens: 5000,
    });
  });

  it("does not fall back to aggregate billing when final-call context is unavailable", async () => {
    const usage = {
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
    };
    const { result, cronSession } = await runUsageCase(usage, {
      ...usage,
      contextUsage: { state: "unavailable" },
    });
    expect(cronSession.sessionEntry.totalTokens).toBeUndefined();
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(false);
    expect(result.usage).toEqual({
      input_tokens: 12,
      output_tokens: 15_104,
      total_tokens: 927_907,
      cache_read_tokens: 819_661,
      cache_write_tokens: 93_130,
    });
  });
});
