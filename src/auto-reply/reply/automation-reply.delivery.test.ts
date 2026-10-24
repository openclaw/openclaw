import { describe, expect, it, vi } from "vitest";
import { markAgentRunFailureReplyPayload } from "./agent-runner-failure-reply.js";
import { accountAgentTurn } from "./agent-runner-result-accounting.js";
import { createTestFinalizationContext } from "./agent-runner-result-accounting.persistence.test-support.js";
import { prepareReplyAgentPayloads } from "./agent-runner-result-payloads.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { createTurn } from "./followup-delivery.test-helpers.js";
import { createMockFollowupRun, createMockReplyOperation } from "./test-helpers.js";

function createContext() {
  const followupRun = createMockFollowupRun({
    originatingChannel: "discord",
    originatingTo: "channel:automation",
    run: { messageProvider: "discord", terminalReplyExpectation: "required" },
  });
  const { replyOperation, failMock } = createMockReplyOperation();
  const context = createTestFinalizationContext(followupRun, replyOperation);
  context.sessionCtx = { Provider: "discord", Surface: "discord", To: "channel:automation" };
  context.execution.automation = {
    result: { outcome: "no_change", summary: "Nothing new." },
    includeReasoning: true,
  };
  return { context, failMock };
}

async function prepare(lane: "ordinary" | "queued", context: FinalizeReplyAgentRunInput) {
  const accounting = await accountAgentTurn(context);
  if (lane === "ordinary") {
    const prepared = await prepareReplyAgentPayloads({ context, accounting });
    return prepared.kind === "continue"
      ? prepared.guardedReplyPayloads
      : prepared.value
        ? [prepared.value].flat()
        : [];
  }
  const decision = await resolveFollowupDeliveryDecision({
    turn: createTurn({
      queued: context.followupRun,
      operation: context.replyOperation,
      config: context.cfg,
    }),
    execution: { runId: context.runId, outcome: context.execution },
    accounting,
    opts: context.opts,
  });
  return decision.kind === "deliver" ? decision.payloads : [];
}

describe.each(["ordinary", "queued"] as const)("%s automation final delivery", (lane) => {
  it("keeps no_change quiet without losing an already committed source reply", async () => {
    const { context, failMock } = createContext();
    const delivered = { text: "Already sent.", sourceReplyFinal: true };
    context.execution.result.sourceReplyDeliveryState = "delivered";
    context.execution.result.messagingToolSourceReplyPayloads = [delivered];
    context.execution.result.payloads = [
      { text: "Unsent explanation." },
      { text: "Reasoning", isReasoning: true },
      { mediaUrl: "https://example.invalid/unsent.png" },
    ];
    context.opts = { reasoningPayloadsEnabled: true };

    expect(await prepare(lane, context)).toEqual([]);
    expect(context.execution.result.sourceReplyDeliveryState).toBe("delivered");
    expect(context.execution.result.messagingToolSourceReplyPayloads).toEqual([delivered]);
    expect(failMock).not.toHaveBeenCalled();
  });

  it("does not invent a missing reply for a completed no_change", async () => {
    const { context, failMock } = createContext();
    context.execution.result.payloads = [{ text: "No updates." }];
    context.opts = { onAgentRunTerminalOutcome: vi.fn() };

    expect(await prepare(lane, context)).toEqual([]);
    expect(failMock).not.toHaveBeenCalled();
    expect(context.opts.onAgentRunTerminalOutcome).not.toHaveBeenCalled();
  });

  it("keeps a terminal failure visible after record_result no_change", async () => {
    const { context } = createContext();
    context.execution = {
      ...context.execution,
      status: "failed",
      terminalFailurePayload: markAgentRunFailureReplyPayload({ text: "Terminal failure" }),
    };
    context.execution.result.payloads = [{ text: "Hidden reasoning", isReasoning: true }];

    expect(await prepare(lane, context)).toMatchObject([
      { text: "Terminal failure", isError: true },
    ]);
  });

  it("does not silence a pending continuation recorded as no_change", async () => {
    const { context } = createContext();
    context.execution.result.meta = {
      durationMs: 0,
      yielded: true,
      yieldAcknowledgment: "Still checking.",
    };
    context.execution.result.payloads = [{ text: "Hidden reasoning", isReasoning: true }];

    expect(await prepare(lane, context)).toMatchObject([{ text: "Still checking." }]);
  });

  it.each([
    { includeReasoning: true, final: "Update found.", expected: ["Reasoning", "Update found."] },
    { includeReasoning: false, final: "Update found.", expected: ["Update found."] },
    { includeReasoning: true, final: undefined, expected: [] },
  ])("delivers reasoning only beside an opted-in final: $includeReasoning/$final", async (row) => {
    const { context } = createContext();
    context.execution.automation = {
      result: { outcome: "progress", summary: "Progress recorded." },
      includeReasoning: row.includeReasoning,
    };
    context.followupRun.run.terminalReplyExpectation = "optional";
    context.execution.result.payloads = [
      { text: "Reasoning", isReasoning: true },
      ...(row.final ? [{ text: row.final }] : []),
    ];
    // The automation opt-in, not an unrelated foreground display preference, owns this lane.
    context.opts = { reasoningPayloadsEnabled: !row.includeReasoning };

    expect((await prepare(lane, context)).map((payload) => payload.text)).toEqual(row.expected);
  });
});
