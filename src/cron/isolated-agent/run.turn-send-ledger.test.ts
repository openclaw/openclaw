import { describe, expect, it } from "vitest";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../../agents/tools/turn-send-ledger.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  isCliProviderMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runCliAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn per-turn send budget", () => {
  setupRunCronIsolatedAgentTurnSuite({ fast: true });

  it("clears a CLI candidate's deferred send-budget scope at the cron terminal", async () => {
    resetTurnSendLedgerForTest();
    mockRunCronFallbackPassthrough();
    isCliProviderMock.mockReturnValue(true);
    // An agent-shifted loopback grant scope that the cron terminal cannot rebuild from its own
    // identity; only the candidate's deferred-scope callback can deliver it there.
    let key: { sessionKey: string; runId: string; targetKey: string } | undefined;
    runCliAgentMock.mockImplementationOnce(async (params) => {
      const scope = { agentId: "shifted", sessionKey: "agent:shifted:main", runId: params.runId };
      key = {
        sessionKey: buildTurnSendLedgerSessionKey(scope.agentId, scope.sessionKey)!,
        runId: params.runId,
        targetKey: "telegram default 12345",
      };
      const reserved = reserveTurnSend(key, {});
      if (reserved.status !== "reserved") {
        throw new Error(`expected a reserved send, got "${reserved.status}"`);
      }
      commitTurnSend(reserved.reservation);
      params.onDeferredTurnSendLedgerScope(scope);
      return { payloads: [{ text: "summary done" }], meta: { agentMeta: {} } };
    });

    const result = await runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture());

    expect(result.status).toBe("ok");
    expect(runCliAgentMock).toHaveBeenCalledOnce();
    expect(peekTurnSendCount(key!)).toBe(0);
  });
});
