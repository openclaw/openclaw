import { afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import {
  QuestionAnswerUnconfirmedError,
  QuestionDispatchRefusedError,
  QuestionDispatchUnsupportedError,
} from "../../agents/harness/gateway-question-dispatch.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  MessageInjectionAcceptedUnconfirmedError,
  MessageInjectionAuthorityError,
  MessageInjectionTargetUnavailableError,
  MessageInjectionWithdrawnError,
} from "./message-injection-authority.js";
import type {
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
} from "./reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";

afterEach(() => testing.resetReplyRunRegistry());

it("keeps cross-profile question answers out of a backend restricted to its turn owner", async () => {
  const authority = (profileId: string) =>
    createAdmittedRunOperatorAuthority({
      profileId,
      scopes: ["operator.read", "operator.write"],
      gatewayAccessGrant: null,
      assertCurrent() {},
    });
  const owner = authority("alice");
  const other = authority("bob");
  for (const supportsCrossProfileSteering of [false, true, undefined]) {
    const operation = createTestReplyOperation();
    operation.bindToolAuthoritySnapshot({
      personalToolOwner: { operatorAuthority: owner },
      fingerprint: () => "same-owner",
      project: () => "same-owner",
    });
    const queueMessage = vi.fn(async () => {});
    const claimPendingUserInputAnswer = vi.fn(async () => true);
    operation.attachBackend({
      kind: "embedded",
      toolAuthorityFingerprint: "same-owner",
      supportsCrossProfileSteering,
      cancel: vi.fn(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        claimPendingUserInputAnswer,
      },
    });
    operation.setPhase("running");
    try {
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
      const answer = async (operatorAuthority: typeof owner) =>
        (
          await beginReplyMessageInjectionTarget(target, "Green", {
            isInboundUserMessage: true,
            toolAuthorityFingerprint: "other-route",
            pendingInputAuthorityFingerprint: "same-owner",
            personalToolParticipant: { operatorAuthority },
          })
        ).outcome;
      await expect(answer(other)).resolves.toMatchObject(
        supportsCrossProfileSteering === false
          ? { status: "rejected", reason: "tool_authority_mismatch" }
          : { status: "accepted" },
      );
      expect(claimPendingUserInputAnswer).toHaveBeenCalledTimes(
        supportsCrossProfileSteering === false ? 0 : 1,
      );
      if (supportsCrossProfileSteering === false) {
        expect(operation.personalToolParticipants?.resolve()?.profileId).toBe("alice");
        expect(() => operation.personalToolParticipants?.resolve("bob")).toThrow(
          "User is not a participant",
        );
      } else {
        expect(operation.personalToolParticipants?.resolve("bob")?.profileId).toBe("bob");
      }
      await expect(answer(owner)).resolves.toMatchObject({ status: "accepted" });
      expect(claimPendingUserInputAnswer).toHaveBeenCalledTimes(
        supportsCrossProfileSteering === false ? 1 : 2,
      );
      expect(queueMessage).not.toHaveBeenCalled();
    } finally {
      operation.complete();
    }
  }
});

it("leaves new human input for a visible followup instead of a hidden coordination turn", async () => {
  const runId = "hidden-coordination-run";
  const queueMessage = vi.fn(async () => {});
  const operation = createTestReplyOperation();
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
      (
        await beginReplyMessageInjectionTarget(target, "What is the status?", {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: "same-owner",
        })
      ).outcome,
    ).resolves.toMatchObject({ status: "rejected", reason: "input_visibility_mismatch" });
    expect(queueMessage).not.toHaveBeenCalled();
  } finally {
    clearAgentRunContext(runId);
  }
});

async function withHiddenQuestionRun(
  injection: ReplyBackendMessageInjectionV2,
  run: (operation: ReturnType<typeof createTestReplyOperation>) => Promise<void>,
) {
  const runId = "hidden-question-run";
  const operation = createTestReplyOperation();
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
  { sink: "claim", failure: "unsupported" },
  { sink: "claim", failure: "refused" },
  { sink: "claim", failure: "unconfirmed" },
  { sink: "image", failure: "unsupported" },
  { sink: "image", failure: "unconfirmed" },
  { sink: "claim", failure: "accepted" },
  { sink: "claim", failure: "source-closed" },
  { sink: "image", failure: "generic" },
  { sink: "claim", failure: "target-closed" },
  { sink: "claim", failure: "target-accepted" },
  { sink: "claim", failure: "target-source-closed" },
  { sink: "claim", failure: "accepted-cleanup" },
  { sink: "claim", failure: "wrapped-accepted-cleanup" },
  { sink: "claim", failure: "accepted-generic" },
  { sink: "claim", failure: "accepted-refused" },
  { sink: "claim", failure: "accepted-source-refusal" },
  { sink: "claim", failure: "withdrawn-unconfirmed" },
  { sink: "claim", failure: "withdrawn-source-closed" },
] as const)("keeps $sink replay decisions bounded after $failure", async ({ sink, failure }) => {
  const unsupported = new QuestionDispatchUnsupportedError("legacy dispatcher");
  const withdrawn = new MessageInjectionWithdrawnError("exact input withdrawn");
  const cleanup = new MessageInjectionAcceptedUnconfirmedError({ cause: new Error("cleanup") });
  const sourceRefusal = new Error("Source session access was revoked");
  const error =
    failure === "accepted-source-refusal"
      ? new MessageInjectionAuthorityError({
          cause: new MessageInjectionAuthorityError({ cause: sourceRefusal }),
        })
      : failure === "withdrawn-source-closed"
        ? withdrawn
        : failure === "refused" || failure === "accepted-refused"
          ? new QuestionDispatchRefusedError("owner refused", { cause: unsupported })
          : failure === "unconfirmed" || failure === "withdrawn-unconfirmed"
            ? new Error("runtime failure", {
                cause: new QuestionAnswerUnconfirmedError(
                  failure === "withdrawn-unconfirmed" ? withdrawn : unsupported,
                ),
              })
            : failure === "accepted-cleanup"
              ? cleanup
              : failure === "wrapped-accepted-cleanup"
                ? new Error("backend completion failed", { cause: cleanup })
                : failure.startsWith("target-")
                  ? new MessageInjectionAuthorityError({
                      cause: new MessageInjectionTargetUnavailableError("Terminal delivery closed"),
                    })
                  : failure === "generic" || failure === "accepted-generic"
                    ? new Error("unknown cancellation failure")
                    : unsupported;
  const reportsAccepted =
    failure === "accepted" ||
    failure === "target-accepted" ||
    failure === "accepted-generic" ||
    failure === "accepted-refused" ||
    failure === "accepted-source-refusal" ||
    failure === "withdrawn-source-closed";
  const indeterminate =
    (reportsAccepted && failure !== "withdrawn-source-closed") ||
    failure === "unconfirmed" ||
    failure === "withdrawn-unconfirmed" ||
    failure === "accepted-cleanup" ||
    failure === "wrapped-accepted-cleanup";
  let sourceCurrent = true;
  const throwFromSink = (
    options: ReplyBackendQueueMessageOptions | undefined,
    assertCurrent: () => void,
  ): never => {
    assertCurrent();
    if (reportsAccepted) {
      options?.onQueueAccepted?.(true);
    }
    if (
      failure === "source-closed" ||
      failure === "target-source-closed" ||
      failure === "withdrawn-source-closed"
    ) {
      sourceCurrent = false;
    }
    throw error;
  };
  const queueMessage = vi.fn(async () => {});
  await withHiddenQuestionRun(
    {
      version: 2,
      isAvailable: () => true,
      queueMessage,
      claimPendingUserInputAnswer: async (_text, options, assertCurrent) =>
        throwFromSink(options, assertCurrent),
      cancelPendingUserInput: async (_resolvedBy, assertCurrent) =>
        throwFromSink(undefined, assertCurrent),
    },
    async (operation) => {
      const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
      const attempt = await beginReplyMessageInjectionTarget(target, "Keep this input", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: "same-owner",
        ...(sink === "image"
          ? { images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] }
          : {}),
        assertCurrent: () => {
          if (!sourceCurrent) {
            throw new Error("source ended after unsupported dispatch");
          }
        },
      });
      if (failure === "generic") {
        await expect(attempt.outcome).rejects.toBe(error);
      } else {
        await expect(attempt.outcome).resolves.toMatchObject({
          status:
            failure === "unsupported" || failure === "target-closed"
              ? "rejected"
              : indeterminate
                ? "indeterminate"
                : "failed",
          ...(failure === "accepted-source-refusal" ? { errorMessage: sourceRefusal.message } : {}),
          ...(failure === "unsupported" || failure === "target-closed"
            ? { reason: "injection_unavailable" }
            : {}),
        });
      }
      await expect(attempt.acceptance).resolves.toBe(indeterminate || reportsAccepted);
      expect(queueMessage).not.toHaveBeenCalled();
      expect(operation.result).toBeNull();
    },
  );
});

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
      const onQueueSettled = vi.fn();
      const result = await (
        await beginReplyMessageInjectionTarget(target!, "Green", {
          isInboundUserMessage: true,
          toolAuthorityFingerprint: testCase.fingerprint,
          pendingInputAuthorityFingerprint: testCase.pending,
          onQueueSettled,
        })
      ).outcome;
      const authorized = testCase.fingerprint === "same-owner" || testCase.pending === "same-owner";
      expect(result.status).toBe(authorized && testCase.claimed ? "accepted" : "rejected");
      expect(onQueueSettled).toHaveBeenCalledTimes(authorized && testCase.claimed ? 1 : 0);
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
        const attempt = await beginReplyMessageInjectionTarget(target!, "Green", {
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
          (
            await beginReplyMessageInjectionTarget(target!, "Use this image", {
              isInboundUserMessage: true,
              toolAuthorityFingerprint: fingerprint,
              images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
              assertCurrent: () => operation.abortSignal.throwIfAborted(),
            })
          ).outcome,
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
    const operation = createTestReplyOperation();
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
    const result = await (
      await beginReplyMessageInjectionTarget(target, "Refresh the card", {
        isInboundUserMessage: true,
        toolAuthorityFingerprint: fingerprint,
        allowPendingUserInputAnswer: false,
        assertCurrent: () => operation.abortSignal.throwIfAborted(),
      })
    ).outcome;
    expect(result.status).toBe(fingerprint === "same-owner" ? "accepted" : "rejected");
    expect(queueMessage).toHaveBeenCalledTimes(fingerprint === "same-owner" ? 1 : 0);
    expect(claim).not.toHaveBeenCalled();
  },
);

it.each(["result", "exception"] as const)(
  "retains steering custody without canceling backing work after an uncertain %s",
  async (receipt) => {
    const operation = createTestReplyOperation();
    const cancel = vi.fn();
    const onQueueAccepted = vi.fn();
    const onOutcome = vi.fn();
    const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(async () => {
      if (receipt === "exception") {
        throw new MessageInjectionAcceptedUnconfirmedError({
          cause: new Error("still awaiting commit"),
        });
      }
      return { transcriptCommit: "unconfirmed", errorMessage: "still awaiting commit" };
    });
    operation.attachBackend({
      kind: "embedded",
      runId: "receipt-run",
      cancel,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
      },
    });
    operation.setPhase("running");
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const attempt = await beginReplyMessageInjectionTarget(target, "Queued guidance", {
      onQueueAccepted,
    });
    const result = await finalizeReplyMessageInjectionAttempt({
      attempt,
      target,
      onOutcome,
    });
    expect(result).toMatchObject({ status: "indeterminate" });
    await expect(attempt.acceptance).resolves.toBe(true);
    expect(onQueueAccepted).toHaveBeenCalledExactlyOnceWith(true);
    expect(onOutcome).toHaveBeenCalledExactlyOnceWith("indeterminate");
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    expect(operation.abortSignal.aborted).toBe(false);
    expect(operation.phase).toBe("running");
    operation.complete();
  },
);

it.each([false, true])(
  "explicit adoption cancellation targets the captured owner (replaced=%s)",
  async (replaced) => {
    const operation = createTestReplyOperation();
    const abortCaptured = vi.spyOn(operation, "abortByUser");
    const cancel = vi.fn();
    operation.attachBackend({
      kind: "embedded",
      cancel,
      messageInjection: { isAvailable: () => true, queueMessage: async () => {} },
    });
    operation.setPhase("running");
    const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)!;
    const attempt = await beginReplyMessageInjectionTarget(target, "Confirmed guidance");
    await expect(attempt.outcome).resolves.toEqual({ status: "accepted" });
    if (replaced) {
      operation.complete();
    }
    const successor = createTestReplyOperation({
      sessionKey: replaced ? operation.key : "agent:main:other",
      sessionId: "next-session",
    });
    const successorCancel = vi.fn();
    successor.attachBackend({ kind: "embedded", cancel: successorCancel });
    successor.setPhase("running");
    const adoptionError = new Error("source adoption lost");
    const result = await finalizeReplyMessageInjectionAttempt({
      attempt,
      target,
      onAdopted: () => {
        throw adoptionError;
      },
      shouldAbortOnAdoptionError: (error) => error === adoptionError,
    });
    expect(result).toMatchObject({ status: "accepted", aborted: true, adoptionError });
    expect(abortCaptured).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledTimes(replaced ? 0 : 1);
    expect(successorCancel).not.toHaveBeenCalled();
    expect(successor.abortSignal.aborted).toBe(false);
    successor.complete();
    operation.complete();
  },
);
