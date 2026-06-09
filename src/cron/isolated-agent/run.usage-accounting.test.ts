import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  deriveSessionTotalTokensMock,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn usage accounting", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("uses final-call usage for the stored session token snapshot", async () => {
    const cronSession = makeCronSession();
    resolveCronSessionMock.mockReturnValue(cronSession);
    mockRunCronFallbackPassthrough();
    deriveSessionTotalTokensMock.mockReturnValueOnce(56000);
    runEmbeddedAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "done" }],
      meta: {
        agentMeta: {
          usage: {
            input: 75000,
            output: 2000,
            cacheRead: 5000,
            cacheWrite: 0,
          },
          lastCallUsage: {
            input: 55000,
            output: 1000,
            cacheRead: 1000,
            cacheWrite: 0,
          },
        },
      },
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentTurnParams());

    expect(result.status).toBe("ok");
    expect(cronSession.sessionEntry.inputTokens).toBe(75000);
    expect(cronSession.sessionEntry.outputTokens).toBe(2000);
    expect(cronSession.sessionEntry.totalTokens).toBe(56000);
    expect(cronSession.sessionEntry.totalTokensFresh).toBe(true);
    expect(deriveSessionTotalTokensMock).toHaveBeenCalledWith({
      usage: {
        input: 55000,
        output: 1000,
        cacheRead: 1000,
        cacheWrite: 0,
      },
      contextTokens: 128000,
      promptTokens: undefined,
    });
  });
});
