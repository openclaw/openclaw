import { afterEach, expect, it, vi } from "vitest";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyBackendMessageInjectionV2 } from "./reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  createReplyOperation,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";

afterEach(() => testing.resetReplyRunRegistry());

it("leaves new human input for a visible followup instead of a hidden coordination turn", async () => {
  const runId = "hidden-coordination-run";
  const queueMessage = vi.fn(async () => {});
  const operation = createReplyOperation({
    sessionKey: "agent:main:coordination",
    sessionId: "session-coordination",
    resetTriggered: false,
  });
  operation.attachBackend({
    kind: "embedded",
    runId,
    toolAuthorityFingerprint: "same-owner",
    cancel: vi.fn(),
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  operation.setPhase("running");
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
  if (!target) {
    throw new Error("Expected a visible run to accept steering before its display scope changed");
  }
  registerAgentRunContext(runId, { isControlUiVisible: false, projectSessionMessages: false });
  try {
    expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)).toMatchObject({
      runId,
    });
    await expect(
      beginReplyMessageInjectionTarget(target, "What is the status?", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "same-owner",
      }).outcome,
    ).resolves.toMatchObject({ status: "rejected", reason: "input_visibility_mismatch" });
    expect(queueMessage).not.toHaveBeenCalled();
  } finally {
    clearAgentRunContext(runId);
  }
});

async function withHiddenQuestionRun(
  injection: ReplyBackendMessageInjectionV2,
  run: (operation: ReturnType<typeof createReplyOperation>) => Promise<void>,
) {
  const runId = "hidden-question-run";
  const operation = createReplyOperation({
    sessionKey: "agent:main:hidden-question",
    sessionId: "session-hidden-question",
    resetTriggered: false,
  });
  operation.attachBackend({
    kind: "embedded",
    runId,
    toolAuthorityFingerprint: "same-owner",
    cancel: vi.fn(),
    messageInjectionV2: injection,
  });
  operation.setPhase("running");
  registerAgentRunContext(runId, { isControlUiVisible: false, projectSessionMessages: false });
  try {
    await run(operation);
  } finally {
    clearAgentRunContext(runId);
    operation.complete();
  }
}

it.each([
  { input: "same authority", fingerprint: "same-owner", pending: undefined, claimed: true },
  { input: "proven route", fingerprint: "other-route", pending: "same-owner", claimed: true },
  { input: "no pending question", fingerprint: "same-owner", pending: undefined, claimed: false },
  { input: "unproven authority", fingerprint: "other-owner", pending: undefined, claimed: true },
])("claims only an authorized pending answer in a hidden run: $input", async (testCase) => {
  const queueMessage = vi.fn(async () => {});
  const claimPendingUserInputAnswer = vi.fn<
    NonNullable<ReplyBackendMessageInjectionV2["claimPendingUserInputAnswer"]>
  >(async (_text, _options, assertCurrent) => {
    assertCurrent();
    return testCase.claimed;
  });
  await withHiddenQuestionRun(
    { version: 2, isAvailable: () => true, queueMessage, claimPendingUserInputAnswer },
    async (operation) => {
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
      expect(target).toBeDefined();
      const result = await beginReplyMessageInjectionTarget(target!, "Green", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: testCase.fingerprint,
        pendingInputAuthorityFingerprint: testCase.pending,
      }).outcome;
      const authorized = testCase.fingerprint === "same-owner" || testCase.pending === "same-owner";
      expect(result.status).toBe(authorized && testCase.claimed ? "accepted" : "rejected");
      expect(claimPendingUserInputAnswer).toHaveBeenCalledTimes(authorized ? 1 : 0);
      expect(queueMessage).not.toHaveBeenCalled();
    },
  );
});

it.each(["source", "backend"] as const)(
  "revalidates hidden question answer authority after asynchronous preparation: %s",
  async (revoked) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const dispatch = vi.fn();
    const queueMessage = vi.fn(async () => {});
    let sourceCurrent = true;
    await withHiddenQuestionRun(
      {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        claimPendingUserInputAnswer: async (_text, _options, assertCurrent, authorityKind) => {
          expect(authorityKind).toBe("source-bound");
          entered.resolve();
          await release.promise;
          assertCurrent();
          dispatch();
          return true;
        },
      },
      async (operation) => {
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
        expect(target).toBeDefined();
        const attempt = beginReplyMessageInjectionTarget(target!, "Green", {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: "same-owner",
          assertCurrent: () => {
            if (!sourceCurrent) {
              throw new Error("source admission ended");
            }
          },
        });
        try {
          await Promise.race([
            entered.promise,
            attempt.outcome.then(() => {
              throw new Error("claim completed before the preparation gate");
            }),
          ]);
          if (revoked === "source") {
            sourceCurrent = false;
          } else {
            operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
          }
          release.resolve();
          await expect(attempt.outcome).resolves.toMatchObject({ status: "failed" });
          await expect(attempt.acceptance).resolves.toBe(false);
          expect(dispatch).not.toHaveBeenCalled();
          expect(queueMessage).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await attempt.outcome;
        }
      },
    );
  },
);

it.each(["same-owner", "other-owner"])(
  "cancels a hidden pending question for image followup only with current authority: %s",
  async (fingerprint) => {
    const queueMessage = vi.fn(async () => {});
    const claimPendingUserInputAnswer = vi.fn(async () => true);
    const cancelPendingUserInput = vi.fn<
      NonNullable<ReplyBackendMessageInjectionV2["cancelPendingUserInput"]>
    >(async (_resolvedBy, assertCurrent, authorityKind) => {
      expect(authorityKind).toBe("source-bound");
      assertCurrent();
      return true;
    });
    await withHiddenQuestionRun(
      {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        claimPendingUserInputAnswer,
        cancelPendingUserInput,
      },
      async (operation) => {
        const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
        expect(target).toBeDefined();
        await expect(
          beginReplyMessageInjectionTarget(target!, "Use this image", {
            isInboundUserMessage: true,
            toolAuthorityFingerprint: fingerprint,
            images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
            assertCurrent: () => operation.abortSignal.throwIfAborted(),
          }).outcome,
        ).resolves.toMatchObject({ status: "rejected", reason: "input_visibility_mismatch" });
        expect(cancelPendingUserInput).toHaveBeenCalledTimes(fingerprint === "same-owner" ? 1 : 0);
        expect(claimPendingUserInputAnswer).not.toHaveBeenCalled();
        expect(queueMessage).not.toHaveBeenCalled();
        expect(operation.phase).toBe("running");
      },
    );
  },
);

it.each(["same-owner", "different-owner"])(
  "status steering preserves question ownership and caller authority (%s)",
  async (fingerprint) => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:refresh",
      sessionId: "refresh-session",
      resetTriggered: false,
    });
    const claim = vi.fn(async () => true);
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
      async (_text, options, assertCurrent) => {
        assertCurrent();
        expect(options?.isInboundUserMessage).toBe(false);
        expect(options?.toolAuthorityFingerprint).toBe("same-owner");
      },
    );
    operation.attachBackend({
      kind: "embedded",
      runId: "working-run",
      toolAuthorityFingerprint: "same-owner",
      cancel: vi.fn(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        claimPendingUserInputAnswer: claim,
      },
    });
    operation.setPhase("running");
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const result = await beginReplyMessageInjectionTarget(target, "Refresh the card", {
      isInboundUserMessage: true,
      toolAuthorityFingerprint: fingerprint,
      allowPendingUserInputAnswer: false,
      assertCurrent: () => operation.abortSignal.throwIfAborted(),
    }).outcome;
    expect(result.status).toBe(fingerprint === "same-owner" ? "accepted" : "rejected");
    expect(queueMessage).toHaveBeenCalledTimes(fingerprint === "same-owner" ? 1 : 0);
    expect(claim).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "only status-only callers preserve work on an uncertain steering receipt (statusOnly=%s)",
  async (statusOnly) => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:receipt",
      sessionId: "receipt-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "receipt-run",
      cancel: vi.fn(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage: async () => ({
          transcriptCommit: "unconfirmed",
          errorMessage: "still awaiting commit",
        }),
      },
    });
    operation.setPhase("running");
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const attempt = beginReplyMessageInjectionTarget(target, "Queued guidance");
    const result = await finalizeReplyMessageInjectionAttempt({
      attempt,
      target,
      ...(statusOnly ? { abortOnUnconfirmedTranscript: false as const } : {}),
    });
    expect(result).toMatchObject({ status: "accepted", aborted: !statusOnly });
    expect(operation.abortSignal.aborted).toBe(!statusOnly);
  },
);
