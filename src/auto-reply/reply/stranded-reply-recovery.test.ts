import { describe, expect, it, vi } from "vitest";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { completeFollowupRunLifecycle, markFollowupRunEnqueued } from "./queue/lifecycle.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { resolveStrandedReplyRecovery } from "./stranded-reply-recovery.js";
import { createMockFollowupRun } from "./test-helpers.js";

function recover(overrides: Partial<Parameters<typeof resolveStrandedReplyRecovery>[0]> = {}) {
  return resolveStrandedReplyRecovery({
    base: createMockFollowupRun({ prompt: "question" }),
    payloads: [],
    finalText: "The answer is ready.",
    terminalReply: { disposition: "visible", text: "The answer is ready." },
    sourceReplyDeliveryMode: "message_tool_only",
    sendPolicyDenied: false,
    successfulSourceReplyDelivery: false,

    isRoomEvent: false,
    ...overrides,
  });
}

describe("buildStrandedReplyRetryFollowupRun lifecycle ownership", () => {
  it("does not share the client turn's turnAdoptionLifecycle with the system retry", () => {
    const receipts: ReplyOperationRunState[] = [{ agentTurn: "ok" }];
    const onComplete = vi.fn();
    const onEnqueued = vi.fn(() => true);
    const parent = createMockFollowupRun({
      prompt: "user question",
      transcriptPrompt: "user question",
      turnAdoptionLifecycle: {
        onAdopted: async () => {},
        onSettled: onComplete,
        onDeferred: onEnqueued,
      },
      admissionSessionId: "sess-rotated",
      replyOperationRunStates: receipts,
    });

    const recovery = recover({ base: parent });
    expect(recovery.kind).toBe("retry");
    if (recovery.kind !== "retry") {
      throw new Error("expected retry recovery");
    }
    const retry = recovery.run;

    expect(retry).toMatchObject({
      turnAdoptionLifecycle: undefined,
      replyOperationRunStates: undefined,
      strandedReplyRetry: true,
      summaryLine: "stranded-reply-retry",
      admissionSessionId: "sess-rotated",
      run: { sessionKey: parent.run.sessionKey },
    });
    expect(parent.replyOperationRunStates).toBe(receipts);

    // mark/complete no-op when lifecycle is absent (drop-policy onDrop path too).
    expect(markFollowupRunEnqueued(retry)).toBe(true);
    expect(onEnqueued).not.toHaveBeenCalled();
    completeFollowupRunLifecycle(retry);
    expect(onComplete).not.toHaveBeenCalled();

    // Parent still owns the one-shot lifecycle; retry completion must not steal it.
    expect(markFollowupRunEnqueued(parent)).toBe(true);
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    completeFollowupRunLifecycle(parent);
    expect(onComplete).toHaveBeenCalledTimes(1);
    completeFollowupRunLifecycle(parent);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe("resolveStrandedReplyRecovery", () => {
  it.each([
    { payload: { text: "The recovered answer is ready." }, expected: "none" },
    {
      payload: { text: "The fallback model is active.", isFallbackNotice: true },
      expected: "retry",
    },
  ])(
    "distinguishes a pending terminal answer from a notice: $expected",
    ({ payload, expected }) => {
      const recovery = recover({
        payloads: [markReplyPayloadForSourceSuppressionDelivery(payload)],
      });

      expect(recovery.kind).toBe(expected);
    },
  );

  it.each([
    { label: "uncapped", toolsAllow: undefined, expected: ["message"] },
    { label: "wildcard", toolsAllow: ["*"], expected: ["message"] },
    { label: "messaging group", toolsAllow: ["group:messaging", "exec"], expected: ["message"] },
    { label: "empty cap", toolsAllow: [], expected: [] },
    { label: "non-messaging cap", toolsAllow: ["exec"], expected: [] },
    {
      label: "intersected denial",
      toolsAllow: attachToolAllowlistIntersection(["message"], [["*"], ["exec"]]),
      expected: [],
    },
  ])("restricts the priority retry to authorized messaging: $label", ({ toolsAllow, expected }) => {
    const base = createMockFollowupRun({ prompt: "question", toolsAllow });

    const recovery = recover({ base });

    expect(recovery.kind).toBe("retry");
    if (recovery.kind === "retry") {
      expect(recovery.run).toMatchObject({
        strandedReplyRetry: true,
        disableCollectBatching: true,
        toolsAllow: expected,
        run: { suppressNextUserMessagePersistence: true },
        transcriptPrompt: undefined,
      });
    }
  });

  it("returns a diagnostic rather than a second retry", () => {
    const base = createMockFollowupRun({ prompt: "question", strandedReplyRetry: true });

    const recovery = recover({
      base,
      finalText: "",
      terminalReply: { disposition: "empty" },
    });

    expect(recovery).toMatchObject({
      kind: "diagnostic",
      payload: {
        text: "No answer was returned. Ask again if you still need one.",
        isError: true,
        isStatusNotice: true,
      },
    });
  });

  it.each([
    { label: "room events", isRoomEvent: true },

    { label: "send-policy denial", sendPolicyDenied: true },
    { label: "completed delivery", successfulSourceReplyDelivery: true },
  ])("does not recover $label", (override) => {
    expect(recover(override)).toEqual({ kind: "none" });
  });
});
