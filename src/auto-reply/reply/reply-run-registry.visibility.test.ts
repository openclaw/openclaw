import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
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
  ReplyBackendHandle,
  ReplyBackendMessageInjectionV2,
  ReplyBackendQueueMessageOptions,
  ReplyMessageInjectionOptions,
} from "./reply-run-registry.contracts.js";
import {
  beginReplyMessageInjectionTarget,
  finalizeReplyMessageInjectionAttempt,
  replyRunRegistry,
} from "./reply-run-registry.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { testing } from "./reply-run-registry.test-support.js";

const hiddenRunId = "hidden-question-run";
afterEach(() => {
  clearAgentRunContext(hiddenRunId);
  testing.resetReplyRunRegistry();
});

type Operation = ReturnType<typeof createTestReplyOperation>;
type Claim = NonNullable<ReplyBackendMessageInjectionV2["claimPendingUserInputAnswer"]>;
const images = () => [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }];
function startRun(backend: Partial<ReplyBackendHandle>, operation = createTestReplyOperation()) {
  operation.attachBackend({ kind: "embedded", cancel: vi.fn(), ...backend });
  operation.setPhase("running");
  return operation;
}
function questionRun(
  injection: Partial<ReplyBackendMessageInjectionV2> = {},
  backend: Partial<ReplyBackendHandle> = {},
  operation = createTestReplyOperation(),
) {
  const queue = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    injection.queueMessage ?? (async () => {}),
  );
  const claim = vi.fn(async () => true);
  startRun(
    {
      toolAuthorityFingerprint: "same-owner",
      ...backend,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        claimPendingUserInputAnswer: claim,
        ...injection,
        queueMessage: queue,
      },
    },
    operation,
  );
  return { operation, queue, claim };
}
function hiddenQuestionRun(injection: Partial<ReplyBackendMessageInjectionV2> = {}) {
  const run = questionRun(injection, { runId: hiddenRunId });
  hideRun();
  return run;
}
function hideRun() {
  registerAgentRunContext(hiddenRunId, {
    isControlUiVisible: false,
    projectSessionMessages: false,
  });
}
function sourceAuthority() {
  return {
    current: true,
    assertCurrent() {
      if (!this.current) {
        throw new Error("source admission ended");
      }
    },
  };
}
async function inboundOutcome(operation: Operation, options: ReplyMessageInjectionOptions = {}) {
  return (await inbound(operation, options)).outcome;
}
function inbound(operation: Operation, options: ReplyMessageInjectionOptions = {}) {
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
  expect(target).toBeDefined();
  return beginReplyMessageInjectionTarget(target!, "Green", {
    isInboundUserMessage: true,
    toolAuthorityFingerprint: "same-owner",
    ...options,
  });
}

it.each([false, true])(
  "cross-profile answers respect backend capability (%s)",
  async (supportsCrossProfileSteering) => {
    const authority = (profileId: string) =>
      createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.read", "operator.write"],
        gatewayAccessGrant: null,
        assertCurrent() {},
      });
    const owner = authority("alice");
    const other = authority("bob");
    const operation = createTestReplyOperation();
    operation.bindToolAuthoritySnapshot({
      personalToolOwner: { operatorAuthority: owner },
      fingerprint: () => "same-owner",
      project: () => "same-owner",
    });
    const { queue, claim } = questionRun({}, { supportsCrossProfileSteering }, operation);
    const answer = async (operatorAuthority: typeof owner) =>
      inboundOutcome(operation, {
        toolAuthorityFingerprint: "other-route",
        pendingInputAuthorityFingerprint: "same-owner",
        personalToolParticipant: { operatorAuthority },
      });
    await expect(answer(other)).resolves.toMatchObject(
      supportsCrossProfileSteering
        ? { status: "accepted" }
        : { status: "rejected", reason: "tool_authority_mismatch" },
    );
    expect(claim).toHaveBeenCalledTimes(supportsCrossProfileSteering ? 1 : 0);
    if (!supportsCrossProfileSteering) {
      expect(operation.personalToolParticipants?.resolve()?.profileId).toBe("alice");
      expect(() => operation.personalToolParticipants?.resolve("bob")).toThrow(
        "User is not a participant",
      );
    } else {
      expect(operation.personalToolParticipants?.resolve("bob")?.profileId).toBe("bob");
    }
    await expect(answer(owner)).resolves.toMatchObject({ status: "accepted" });
    expect(claim).toHaveBeenCalledTimes(supportsCrossProfileSteering ? 2 : 1);
    expect(queue).not.toHaveBeenCalled();
  },
);

it("leaves new human input for a visible followup instead of a hidden coordination turn", async () => {
  const queueMessage = vi.fn(async () => {});
  const operation = startRun({
    runId: hiddenRunId,
    toolAuthorityFingerprint: "same-owner",
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  const target = replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key);
  expect(target).toBeDefined();
  hideRun();
  expect(replyRunRegistry.resolveCurrentMessageInjectionTarget(operation.key)).toMatchObject({
    runId: hiddenRunId,
  });
  const attempt = await beginReplyMessageInjectionTarget(target!, "What is the status?", {
    isInboundUserMessage: true,
    toolAuthorityFingerprint: "same-owner",
  });
  await expect(attempt.outcome).resolves.toMatchObject({
    status: "rejected",
    reason: "input_visibility_mismatch",
  });
  expect(queueMessage).not.toHaveBeenCalled();
});

it.each([
  { sink: "claim", failure: "refused" },
  { sink: "image", failure: "unsupported" },
  { sink: "image", failure: "unconfirmed" },
  { sink: "claim", failure: "accepted" },
  { sink: "image", failure: "generic" },
  { sink: "claim", failure: "target-accepted" },
  { sink: "claim", failure: "target-source-closed" },
  { sink: "claim", failure: "withdrawn-source-closed" },
] as const)("keeps $sink replay decisions bounded after $failure", async ({ sink, failure }) => {
  const unsupported = new QuestionDispatchUnsupportedError("legacy dispatcher");
  const targetError = new MessageInjectionAuthorityError({
    cause: new MessageInjectionTargetUnavailableError("Terminal delivery closed"),
  });
  const error = {
    refused: new QuestionDispatchRefusedError("owner refused", { cause: unsupported }),
    unsupported,
    unconfirmed: new Error("runtime failure", {
      cause: new QuestionAnswerUnconfirmedError(unsupported),
    }),
    accepted: unsupported,
    generic: new Error("unknown cancellation failure"),
    "target-accepted": targetError,
    "target-source-closed": targetError,
    "withdrawn-source-closed": new MessageInjectionWithdrawnError("exact input withdrawn"),
  }[failure];
  const reportsAccepted =
    failure === "accepted" ||
    failure === "target-accepted" ||
    failure === "withdrawn-source-closed";
  const indeterminate =
    (reportsAccepted && failure !== "withdrawn-source-closed") || failure === "unconfirmed";
  const source = sourceAuthority();
  const throwFromSink = (
    options: ReplyBackendQueueMessageOptions | undefined,
    assertCurrent: () => void,
  ): never => {
    assertCurrent();
    if (reportsAccepted) {
      options?.onQueueAccepted?.(true);
    }
    if (failure === "target-source-closed" || failure === "withdrawn-source-closed") {
      source.current = false;
    }
    throw error;
  };
  const { operation, queue } = hiddenQuestionRun({
    claimPendingUserInputAnswer: async (_text, options, assertCurrent) =>
      throwFromSink(options, assertCurrent),
    cancelPendingUserInput: async (_resolvedBy, assertCurrent) =>
      throwFromSink(undefined, assertCurrent),
  });
  const attempt = await inbound(operation, {
    ...(sink === "image" ? { images: images() } : {}),
    assertCurrent: () => source.assertCurrent(),
  });
  if (failure === "generic") {
    await expect(attempt.outcome).rejects.toBe(error);
  } else {
    await expect(attempt.outcome).resolves.toMatchObject({
      status: failure === "unsupported" ? "rejected" : indeterminate ? "indeterminate" : "failed",
      ...(failure === "unsupported" ? { reason: "injection_unavailable" } : {}),
    });
  }
  await expect(attempt.acceptance).resolves.toBe(indeterminate || reportsAccepted);
  expect(queue).not.toHaveBeenCalled();
  expect(operation.result).toBeNull();
});

it.each([
  { input: "same authority", fingerprint: "same-owner", claimed: true },
  { input: "no pending question", fingerprint: "same-owner", claimed: false },
  { input: "unproven authority", fingerprint: "other-owner", claimed: true },
])("claims only an authorized pending answer in a hidden run: $input", async (testCase) => {
  const claim = vi.fn<Claim>(async (_text, _options, assertCurrent) => {
    assertCurrent();
    return testCase.claimed;
  });
  const { operation, queue } = hiddenQuestionRun({ claimPendingUserInputAnswer: claim });
  const onQueueSettled = vi.fn();
  const result = await inboundOutcome(operation, {
    toolAuthorityFingerprint: testCase.fingerprint,
    onQueueSettled,
  });
  const authorized = testCase.fingerprint === "same-owner";
  expect(result.status).toBe(authorized && testCase.claimed ? "accepted" : "rejected");
  expect(onQueueSettled).toHaveBeenCalledTimes(authorized && testCase.claimed ? 1 : 0);
  expect(claim).toHaveBeenCalledTimes(authorized ? 1 : 0);
  expect(queue).not.toHaveBeenCalled();
});

it.each(["source", "backend"] as const)(
  "revalidates hidden question answer authority after asynchronous preparation: %s",
  async (revoked) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const dispatch = vi.fn();
    const source = sourceAuthority();
    const { operation, queue } = hiddenQuestionRun({
      claimPendingUserInputAnswer: async (_text, _options, assertCurrent, authorityKind) => {
        expect(authorityKind).toBe("source-bound");
        entered.resolve();
        await release.promise;
        assertCurrent();
        dispatch();
        return true;
      },
    });
    const attempt = await inbound(operation, {
      assertCurrent: () => source.assertCurrent(),
    });
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        attempt.outcome,
        "claim completed before the preparation gate",
      );
      if (revoked === "source") {
        source.current = false;
      } else {
        operation.attachBackend({ kind: "embedded", cancel: vi.fn() });
      }
      release.resolve();
      await expect(attempt.outcome).resolves.toMatchObject({ status: "failed" });
      await expect(attempt.acceptance).resolves.toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await attempt.outcome;
    }
  },
);

it.each(["same-owner", "other-owner"])(
  "cancels a hidden pending question for image followup only with current authority: %s",
  async (fingerprint) => {
    const cancelPendingUserInput = vi.fn<
      NonNullable<ReplyBackendMessageInjectionV2["cancelPendingUserInput"]>
    >(async (_resolvedBy, assertCurrent, authorityKind) => {
      expect(authorityKind).toBe("source-bound");
      assertCurrent();
      return true;
    });
    const { operation, queue, claim } = hiddenQuestionRun({ cancelPendingUserInput });
    await expect(
      inboundOutcome(operation, {
        toolAuthorityFingerprint: fingerprint,
        images: images(),
        assertCurrent: () => operation.abortSignal.throwIfAborted(),
      }),
    ).resolves.toMatchObject({ status: "rejected", reason: "input_visibility_mismatch" });
    expect(cancelPendingUserInput).toHaveBeenCalledTimes(fingerprint === "same-owner" ? 1 : 0);
    expect(claim).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
    expect(operation.phase).toBe("running");
  },
);

it.each(["same-owner", "different-owner"])(
  "status steering preserves question ownership and caller authority (%s)",
  async (fingerprint) => {
    const { operation, claim, queue } = questionRun(
      {
        queueMessage: async (_text, options, assertCurrent) => {
          assertCurrent();
          expect(options).toMatchObject({
            isInboundUserMessage: false,
            toolAuthorityFingerprint: "same-owner",
          });
        },
      },
      { runId: "working-run" },
    );
    const result = await inboundOutcome(operation, {
      toolAuthorityFingerprint: fingerprint,
      allowPendingUserInputAnswer: false,
      assertCurrent: () => operation.abortSignal.throwIfAborted(),
    });
    expect(result.status).toBe(fingerprint === "same-owner" ? "accepted" : "rejected");
    expect(queue).toHaveBeenCalledTimes(fingerprint === "same-owner" ? 1 : 0);
    expect(claim).not.toHaveBeenCalled();
  },
);

it.each(["result", "exception"] as const)(
  "retains steering custody without canceling backing work after an uncertain %s",
  async (receipt) => {
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
    const operation = startRun({
      runId: "receipt-run",
      cancel,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
      },
    });
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
  },
);

it.each([false, true])(
  "explicit adoption cancellation targets the captured owner (replaced=%s)",
  async (replaced) => {
    const operation = createTestReplyOperation();
    const abortCaptured = vi.spyOn(operation, "abortByUser");
    const cancel = vi.fn();
    startRun(
      {
        cancel,
        messageInjection: { isAvailable: () => true, queueMessage: async () => {} },
      },
      operation,
    );
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
    startRun({ cancel: successorCancel }, successor);
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
  },
);
