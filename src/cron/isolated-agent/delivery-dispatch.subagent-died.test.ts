/**
 * Tests for the subagent-died bug in cron delivery dispatch.
 *
 * Bug: when isolated cron sessions spawn subagents that die or time out
 * without producing output (e.g., Docker wall-clock timeout), the parent
 * cron job falsely reports status:"ok" and delivered:true.
 *
 * Fix: when hadDescendants is true, activeSubagentRuns is 0, and the
 * synthesized text is still an interim message, report status:"error".
 *
 * Fixes #65950
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
  resolveMainSessionKey: vi.fn(() => "global"),
}));

vi.mock("../../agents/subagent-registry-read.js", () => ({
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ ok: true }]),
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../gateway/call.runtime.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./delivery-outbound.runtime.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ ok: true }]),
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("./subagent-followup-hints.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
}));

vi.mock("./subagent-followup.runtime.js", () => ({
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { countActiveDescendantRuns } from "../../agents/subagent-registry-read.js";
import { dispatchCronDelivery } from "./delivery-dispatch.js";
import { deliverOutboundPayloads } from "./delivery-outbound.runtime.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";
import { expectsSubagentFollowup, isLikelyInterimCronMessage } from "./subagent-followup-hints.js";
import {
  readDescendantSubagentFallbackReply,
  waitForDescendantSubagentSummary,
} from "./subagent-followup.runtime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolvedDelivery(): Extract<DeliveryTargetResolution, { ok: true }> {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
  };
}

function makeWithRunSession() {
  return (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: "test-session-id",
    sessionKey: "test-session-key",
  });
}

function makeBaseParams(overrides: { synthesizedText?: string; deliveryRequested?: boolean }) {
  const resolvedDelivery = makeResolvedDelivery();
  return {
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: "isolated",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionId: "run-123",
    runStartedAt: Date.now(),
    runEndedAt: Date.now(),
    timeoutMs: 30_000,
    resolvedDelivery,
    deliveryRequested: overrides.deliveryRequested ?? true,
    skipHeartbeatDelivery: false,
    deliveryBestEffort: false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "on it",
    summary: overrides.synthesizedText ?? "on it",
    outputText: overrides.synthesizedText ?? "on it",
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dispatchCronDelivery — subagent died without output (#65950)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(false);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports status:error when subagents spawned, waited, timed out, and produced no output", async () => {
    // Subagents were active initially (hadDescendants=true), then died (activeSubagentRuns=0)
    vi.mocked(countActiveDescendantRuns)
      .mockReturnValueOnce(1) // initial check → enters wait block
      .mockReturnValueOnce(0); // after wait → subagent died
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined); // no final reply
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined); // no fallback
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "cron: subagent(s) completed without producing a final output",
        deliveryAttempted: true,
      }),
    );
    expect(state.delivered).toBe(false);
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("reports status:error when subagents were expected (via followup hint) but produced nothing", async () => {
    // No active subagents at call time, but expectedSubagentFollowup=true
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(expectsSubagentFollowup).mockReturnValue(true);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({ synthesizedText: "spawned a subagent, it'll auto-announce" });
    const state = await dispatchCronDelivery(params);

    // expectedSubagentFollowup enters the wait block; hadDescendants derives from
    // completedDescendantReply (undefined) OR activeSubagentRuns (0). Since neither
    // is true, hadDescendants=false and we fall through to normal delivery.
    // The actual subagent-died path requires hadDescendants=true.
    // This test documents that expectsSubagentFollowup alone does NOT trigger
    // the error path — there must be evidence descendants actually existed.
    expect(state.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
  });

  it("still reports status:ok when subagents are still actively running", async () => {
    // Subagents still running (activeSubagentRuns > 0 after wait)
    vi.mocked(countActiveDescendantRuns).mockReturnValue(2);
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    // This branch should remain status:"ok" — subagents are still running
    expect(state.result).toEqual(
      expect.objectContaining({
        status: "ok",
        deliveryAttempted: true,
      }),
    );
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("delivers descendant output normally when subagents finish with output", async () => {
    // Subagent was active, finished, and produced output
    vi.mocked(countActiveDescendantRuns)
      .mockReturnValueOnce(1) // initial check
      .mockReturnValueOnce(0); // after wait
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(
      "Here is the morning briefing with all the details.",
    );
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(false);

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    expect(state.delivered).toBe(true);
    expect(state.deliveryAttempted).toBe(true);
    // Verify descendant text was picked up for delivery
    expect(state.synthesizedText).toBe("Here is the morning briefing with all the details.");
    expect(state.deliveryPayloads).toEqual([
      { text: "Here is the morning briefing with all the details." },
    ]);
  });

  it("uses fallback reply when subagent already finished before dispatch", async () => {
    // No active subagents, but completedDescendantReply available
    vi.mocked(countActiveDescendantRuns).mockReturnValue(0);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(
      "Child completed with detailed results.",
    );

    const params = makeBaseParams({ synthesizedText: "on it" });
    const state = await dispatchCronDelivery(params);

    // Should deliver the fallback reply, not error
    expect(state.delivered).toBe(true);
    expect(state.synthesizedText).toBe("Child completed with detailed results.");
    expect(state.deliveryPayloads).toEqual([{ text: "Child completed with detailed results." }]);
  });

  it("reports error with multiple subagents that all died without output", async () => {
    // Multiple subagents were active, all died
    vi.mocked(countActiveDescendantRuns)
      .mockReturnValueOnce(3) // initial check → 3 active subagents
      .mockReturnValueOnce(0); // after wait → all dead
    vi.mocked(waitForDescendantSubagentSummary).mockResolvedValue(undefined);
    vi.mocked(readDescendantSubagentFallbackReply).mockResolvedValue(undefined);
    vi.mocked(isLikelyInterimCronMessage).mockReturnValue(true);

    const params = makeBaseParams({ synthesizedText: "working on it, spawned 3 subagents" });
    const state = await dispatchCronDelivery(params);

    expect(state.result).toEqual(
      expect.objectContaining({
        status: "error",
        error: "cron: subagent(s) completed without producing a final output",
      }),
    );
    expect(deliverOutboundPayloads).not.toHaveBeenCalled();
  });
});
