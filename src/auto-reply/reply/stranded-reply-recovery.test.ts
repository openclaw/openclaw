import { expect, it, vi } from "vitest";
import { resolveReplyExpectation } from "../../agents/reply-completion.js";
import { attachToolAllowlistIntersection } from "../../agents/tool-policy-shared.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import { resolveFollowupCurrentMessageId } from "./agent-runner-utils.js";
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

function retry(base: Parameters<typeof resolveStrandedReplyRecovery>[0]["base"]) {
  const recovery = recover({ base });
  if (recovery.kind !== "retry") {
    throw new Error(`expected retry recovery, received ${recovery.kind}`);
  }
  return recovery.run;
}

it("does not share the client turn's turnAdoptionLifecycle with the system retry", () => {
  const receipts: ReplyOperationRunState[] = [{}];
  const onComplete = vi.fn();
  const onEnqueued = vi.fn(() => true);
  const parent = createMockFollowupRun({
    prompt: "user question",
    turnAdoptionLifecycle: {
      onAdopted: async () => {},
      onSettled: onComplete,
      onDeferred: onEnqueued,
    },
    admissionSessionId: "sess-rotated",
    replyOperationRunStates: receipts,
  });

  const run = retry(parent);

  expect(run).toMatchObject({
    turnAdoptionLifecycle: undefined,
    replyOperationRunStates: undefined,
    admissionSessionId: "sess-rotated",
    run: { sessionKey: parent.run.sessionKey },
  });
  expect(parent.replyOperationRunStates).toBe(receipts);

  expect(markFollowupRunEnqueued(run)).toBe(true);
  expect(onEnqueued).not.toHaveBeenCalled();
  completeFollowupRunLifecycle(run);
  expect(onComplete).not.toHaveBeenCalled();

  expect(markFollowupRunEnqueued(parent)).toBe(true);
  expect(onEnqueued).toHaveBeenCalledTimes(1);
  completeFollowupRunLifecycle(parent);
  expect(onComplete).toHaveBeenCalledTimes(1);
  completeFollowupRunLifecycle(parent);
  expect(onComplete).toHaveBeenCalledTimes(1);
});

it("expires the client turn's skill authoring grant instead of rebinding it", async () => {
  // chat.send mints a personal grant that refuses a second run; carrying it over killed the retry.
  const parent = createMockFollowupRun({ prompt: "user question" });
  parent.run.skillLibraryAuthoring = {
    target: "personal",
    defaultTarget: "workspace",
    multipleProfiles: true,
    bind: () => {
      throw new Error("Personal authoring cannot move to a replacement run.");
    },
    invoke: vi.fn(),
  };

  const authoring = retry(parent).run.skillLibraryAuthoring;
  expect(authoring?.defaultTarget).toBe("personal");
  expect(() => authoring?.bind({} as never)).not.toThrow();
  await expect(authoring?.invoke({ action: "list" })).rejects.toMatchObject({
    code: "AUTHORITY_EXPIRED",
  });
});
it("does not mistake a pending fallback notice for a terminal answer", () => {
  const notice = { text: "The fallback model is active.", isFallbackNotice: true };
  const payloads = [markReplyPayloadForSourceSuppressionDelivery(notice)];
  expect(recover({ payloads }).kind).toBe("retry");
});

it.each([
  [undefined, ["message"]],
  [["*"], ["message"]],
  [["group:messaging", "exec"], ["message"]],
  [[], []],
  [["exec"], []],
  [attachToolAllowlistIntersection(["message"], [["*"], ["exec"]]), []],
])("restricts the priority retry to authorized messaging: %j", (toolsAllow, expected) => {
  const base = createMockFollowupRun({ prompt: "question", toolsAllow });

  expect(retry(base).toolsAllow).toEqual(expected);
});

it.each(["isRoomEvent", "sendPolicyDenied", "successfulSourceReplyDelivery"] as const)(
  "does not recover when %s",
  (key) => {
    expect(recover({ [key]: true })).toEqual({ kind: "none" });
  },
);

it("keeps the source reply obligation and second-miss diagnostic on the host retry", () => {
  const base = createMockFollowupRun({ prompt: "question", messageId: "source-message" });
  base.run.inputProvenance = { kind: "external_user" };
  base.run.terminalReplyExpectation = undefined;
  const expectation = resolveReplyExpectation({
    ...base.run,
    scheduledAutomation: base.run.scheduledAutomation !== undefined,
  });
  const run = retry(base);
  expect(run.run.inputProvenance).toEqual({
    kind: "internal_system",
    sourceTool: "stranded_reply_retry",
  });
  expect(
    resolveReplyExpectation({
      ...run.run,
      scheduledAutomation: run.run.scheduledAutomation !== undefined,
    }),
  ).toBe(expectation);
  expect(resolveFollowupCurrentMessageId(run)).toBe("source-message");
  expect(recover({ base: run })).toMatchObject({ kind: "diagnostic" });
});
