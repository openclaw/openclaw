import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveSessionModelSwitchError } from "../../agents/live-model-switch-error.js";
import {
  buildTurnSendLedgerSessionKey,
  commitTurnSend,
  peekTurnSendCount,
  reserveTurnSend,
  resetTurnSendLedgerForTest,
} from "../../agents/tools/turn-send-ledger.js";
import type { TemplateContext } from "../templating.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  getExecuteAgentTurnForTest,
  initialFallbackAttemptOptions,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";
import type { FallbackRunnerParams } from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

// A dispatched loopback grant commits under a canonical, agent-shifted scope that the
// enclosing run's raw (agentId "main", session "session-1") identity cannot reconstruct.
// Only the owner-held deferred drain — reached through onDeferredTurnSendLedgerScope — can
// clear it, so these keys prove the callback survives the auto-reply candidate hop.
const GRANT_AGENT_ID = "reef";
const GRANT_SESSION = "agent:reef:main";
const TARGET_KEY = "imessage\0default\0+15550001111";
const GRANT_LEDGER_SESSION_KEY = buildTurnSendLedgerSessionKey(GRANT_AGENT_ID, GRANT_SESSION)!;

// The dispatched candidate's loopback send lands under the canonical grant slot, then the
// candidate defers that exact scope to the logical-run owner. Returns the committed count so
// the test can assert the slot really existed before the terminal drain removed it.
function commitGrantSendAndDefer(runId: string, defer: (scope: unknown) => void): number {
  const grantKey = { sessionKey: GRANT_LEDGER_SESSION_KEY, runId, targetKey: TARGET_KEY };
  const reserved = reserveTurnSend(grantKey, {});
  if (reserved.status !== "reserved") {
    throw new Error(`expected a reserved send, got "${reserved.status}"`);
  }
  const committed = commitTurnSend(reserved.reservation);
  defer({ agentId: GRANT_AGENT_ID, sessionKey: GRANT_SESSION, runId });
  return committed;
}

function grantSlotCount(runId: string): number {
  return peekTurnSendCount({ sessionKey: GRANT_LEDGER_SESSION_KEY, runId, targetKey: TARGET_KEY });
}

describe("executeAgentTurn: per-turn send ledger deferred-scope propagation", () => {
  beforeEach(resetTurnSendLedgerForTest);
  afterEach(resetTurnSendLedgerForTest);

  it("forwards the owner's deferred-scope collector into the embedded candidate so a dispatched grant is drained", async () => {
    state.isCliProviderMock.mockReturnValue(false);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "anthropic",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));

    let runId: string | undefined;
    let committed: number | undefined;
    state.runEmbeddedAgentMock.mockImplementationOnce(
      async (params: {
        runId: string;
        onDeferredTurnSendLedgerScope?: (scope: unknown) => void;
      }) => {
        // The defect: the auto-reply candidate dropped this callback, so the canonical grant
        // slot leaked past the run's terminal. It must reach the embedded runner intact.
        expect(typeof params.onDeferredTurnSendLedgerScope).toBe("function");
        runId = params.runId;
        committed = commitGrantSendAndDefer(params.runId, params.onDeferredTurnSendLedgerScope!);
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "whatsapp", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    expect(committed).toBe(1);
    // The owner's raw scope never resolves the canonical grant slot; the deferred drain did.
    expect(grantSlotCount(runId!)).toBe(0);
  });

  it("forwards the owner's deferred-scope collector into the CLI candidate so a dispatched grant is drained", async () => {
    state.isCliProviderMock.mockReturnValue(true);
    state.runWithModelFallbackMock.mockImplementationOnce(async (params: FallbackRunnerParams) => ({
      result: await params.run(
        "claude-cli",
        "claude-sonnet-4-6",
        initialFallbackAttemptOptions(params),
      ),
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      attempts: [],
    }));

    let runId: string | undefined;
    let committed: number | undefined;
    state.runCliAgentMock.mockImplementationOnce(
      async (params: {
        runId: string;
        onDeferredTurnSendLedgerScope?: (scope: unknown) => void;
      }) => {
        expect(typeof params.onDeferredTurnSendLedgerScope).toBe("function");
        runId = params.runId;
        committed = commitGrantSendAndDefer(params.runId, params.onDeferredTurnSendLedgerScope!);
        return { payloads: [{ text: "done" }], meta: {} };
      },
    );

    const followupRun = createFollowupRun();
    followupRun.run.provider = "claude-cli";
    followupRun.run.model = "claude-sonnet-4-6";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "telegram", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    expect(committed).toBe(1);
    expect(grantSlotCount(runId!)).toBe(0);
  });

  it("keeps the turn's send budget across a live model-switch retry and clears it at the turn terminal", async () => {
    state.isCliProviderMock.mockReturnValue(false);
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      const provider = params.provider ?? "anthropic";
      const model = params.model ?? "claude-sonnet-4-6";
      return {
        result: await params.run(provider, model, initialFallbackAttemptOptions(params)),
        provider,
        model,
        attempts: [],
      };
    });

    type EmbeddedParams = {
      runId: string;
      agentId: string;
      sessionId: string;
      sessionKey?: string;
      onDeferredTurnSendLedgerScope?: (scope: unknown) => void;
    };
    // The tools' native scope for this run (attempt-setup.ts agentSessionKey).
    const nativeKey = (params: EmbeddedParams) => ({
      sessionKey: buildTurnSendLedgerSessionKey(
        params.agentId,
        params.sessionKey?.trim() || params.sessionId,
      )!,
      runId: params.runId,
      targetKey: TARGET_KEY,
    });
    const runIds: string[] = [];
    const seenByRetry: number[] = [];
    let firstCycle: EmbeddedParams | undefined;
    state.runEmbeddedAgentMock
      .mockImplementationOnce(async (params: EmbeddedParams) => {
        firstCycle = params;
        runIds.push(params.runId);
        const reserved = reserveTurnSend(nativeKey(params), {});
        if (reserved.status !== "reserved") {
          throw new Error(`expected a reserved send, got "${reserved.status}"`);
        }
        commitTurnSend(reserved.reservation);
        commitGrantSendAndDefer(params.runId, params.onDeferredTurnSendLedgerScope!);
        throw new LiveSessionModelSwitchError({ provider: "openai", model: "gpt-5.4" });
      })
      .mockImplementationOnce(async (params: EmbeddedParams) => {
        runIds.push(params.runId);
        seenByRetry.push(peekTurnSendCount(nativeKey(params)), grantSlotCount(params.runId));
        return { payloads: [{ text: "switched" }], meta: {} };
      });

    const followupRun = createFollowupRun();
    followupRun.run.provider = "anthropic";
    followupRun.run.model = "claude-sonnet-4-6";

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: { Provider: "whatsapp", MessageSid: "msg" } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("success");
    // The retry is the same logical turn, so it sees the first cycle's sends.
    expect(runIds).toHaveLength(2);
    expect(runIds[1]).toBe(runIds[0]);
    expect(seenByRetry).toEqual([1, 1]);
    // The turn owner cleared both scopes once the turn ended.
    expect(peekTurnSendCount(nativeKey(firstCycle!))).toBe(0);
    expect(grantSlotCount(firstCycle!.runId)).toBe(0);
  });
});
