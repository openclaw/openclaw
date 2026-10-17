import {
  hasCompletionMessageSessionSpawn,
  type AcceptedSessionSpawn,
} from "../../agents/accepted-session-spawn.js";
import { adoptMediaGenerationProgressDraft } from "../../agents/media-generation-activity.js";
import { isRequiredReplyExpectation, type ReplyCompletion } from "../../agents/reply-completion.js";
import { listSessionFollowupCompletions } from "../../agents/subagents/completion/session-followup-completion.js";
import type { FollowupCompletionOwner } from "../../agents/subagents/completion/session-followup-completion.types.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "../../agents/subagents/registry/subagent-registry-persistence.js";
import type { ProgressContinuationCapability } from "../../channels/progress-continuation.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import { replyRunState } from "./reply-run-registry.state.js";

type WaitingStatusContext = Pick<
  FinalizeReplyAgentRunInput,
  | "execution"
  | "followupRun"
  | "opts"
  | "replyOperation"
  | "runId"
  | "runtimePolicySessionKey"
  | "sessionKey"
>;

export function prepareWaitingStatusContext(
  context: WaitingStatusContext,
  terminalReplyExpectation: ReplyCompletion["expectation"],
) {
  const { execution, followupRun, opts, replyOperation, runId, sessionKey } = context;
  const runResult = execution.result;
  const implicitContinuation = runResult.meta?.continuationPending === true;
  const peerFollowups =
    terminalReplyExpectation === "required"
      ? listSessionFollowupCompletions({
          requesterSessionKey: sessionKey ?? followupRun.run.sessionKey ?? "",
          requesterAgentId: followupRun.run.agentId,
          requesterTurnRunId: runId,
        })
      : [];
  // Completion-message children own their continuation; detached media retains its own run owner.
  const continuationOwner =
    implicitContinuation && hasCompletionMessageSessionSpawn(runResult.acceptedSessionSpawns)
      ? {
          stateContext: captureOpenClawStateWorkerContext(),
          operationKey: replyOperation.key,
          operationSessionId: replyOperation.sessionId,
        }
      : undefined;
  const pendingContinuation =
    runResult.meta?.yielded === true ||
    implicitContinuation ||
    peerFollowups.length > 0 ||
    (runResult.meta?.pendingToolCalls?.length ?? 0) > 0;
  if (pendingContinuation && !implicitContinuation) {
    opts?.onPendingContinuation?.();
  }
  return { implicitContinuation, peerFollowups, continuationOwner, pendingContinuation };
}

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  mediaContinuation?: boolean;
  peerContinuation?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  const text =
    params.yieldAcknowledgment?.trim() ||
    (params.mediaContinuation || params.peerContinuation
      ? "I’m continuing this work and will send the result when it is ready."
      : undefined);
  if (
    !isRequiredReplyExpectation(params.completion.expectation) ||
    params.completion.outcome !== "pending" ||
    (!params.yielded && !params.continuationPending) ||
    params.hasVisibleMessageDelivery ||
    !text
  ) {
    return undefined;
  }
  return setReplyPayloadMetadata(
    { text },
    {
      deliverDespiteSourceReplySuppression: true,
      continuationStatus: true,
    },
  );
}

/**
 * Ordinary and queued waiting replies offer their progress draft to the work
 * that owes the result: the yielding turn's children, or its in-flight media runs.
 */
export async function attachWaitingStatusProgressContinuation(params: {
  payload?: ReplyPayload;
  replyPayloads?: readonly ReplyPayload[];
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  followups?: readonly FollowupCompletionOwner[];
  /** Set only for a media continuation, which has no completion child. */
  mediaRequester?: { sessionKey: string; agentId?: string };
  operation: ReplyOperation;
}): Promise<void> {
  const { acceptedSessionSpawns, followups, mediaRequester, operation } = params;
  const payload =
    params.payload ??
    (followups?.length ? params.replyPayloads?.findLast((reply) => !reply.isError) : undefined);
  if (!payload) {
    return;
  }
  let adoptDraft: ProgressContinuationCapability["adopt"];
  if (mediaRequester) {
    adoptDraft = (draft) =>
      adoptMediaGenerationProgressDraft(mediaRequester.sessionKey, mediaRequester.agentId, draft);
  } else if (acceptedSessionSpawns?.length || followups?.length) {
    // Ordinary replies must not load the subagent registry.
    const { adoptSubagentProgressDraft } =
      await import("../../agents/subagents/registry/subagent-progress-draft.js");
    adoptDraft = (draft) =>
      adoptSubagentProgressDraft(acceptedSessionSpawns ?? [], draft, followups);
  } else {
    return;
  }
  let open = true;
  setReplyPayloadMetadata(payload, {
    progressContinuation: {
      ...(payload !== params.payload ? { preserveReply: true } : {}),
      adopt: (draft) =>
        open && resolveReplyOperationAbortReason(operation) === undefined && adoptDraft(draft),
      close: () => {
        open = false;
      },
    },
  });
}

export async function prepareWaitingStatusContinuation(params: {
  context: WaitingStatusContext;
  payload?: ReplyPayload;
  replyPayloads?: readonly ReplyPayload[];
  followups?: readonly FollowupCompletionOwner[];
  owner?: {
    stateContext: OpenClawStateWorkerContext;
    operationKey: string;
    operationSessionId: string;
  };
}): Promise<void> {
  const { context, payload, owner } = params;
  const {
    execution,
    followupRun,
    opts,
    replyOperation,
    runId,
    runtimePolicySessionKey,
    sessionKey,
  } = context;
  const acceptedSessionSpawns = execution.result.acceptedSessionSpawns;
  // Media admission owns runs under the tools' runtime policy key, not a shared main key.
  const mediaSessionKey =
    execution.result.meta?.continuationPending === true && !owner
      ? (runtimePolicySessionKey ?? sessionKey ?? followupRun.run.sessionKey)
      : undefined;
  if (payload || params.followups?.length) {
    await attachWaitingStatusProgressContinuation({
      payload,
      replyPayloads: params.replyPayloads,
      followups: params.followups,
      acceptedSessionSpawns,
      mediaRequester: mediaSessionKey
        ? { sessionKey: mediaSessionKey, agentId: followupRun.run.agentId }
        : undefined,
      operation: replyOperation,
    });
  }
  if (!owner) {
    return;
  }
  const requesterSessionKey = sessionKey ?? followupRun.run.sessionKey;
  if (!requesterSessionKey || !acceptedSessionSpawns?.length) {
    throw new Error("accepted continuation status could not be prepared for delivery");
  }
  const { stateContext, operationKey, operationSessionId } = owner;
  const assertRequesterCurrent = () => {
    assertSubagentRegistryWriteSourceCurrent(stateContext);
    // Abort can still owe non-yielded cleanup; replacement cannot inherit this cohort.
    if (
      replyRunState.activeRunsByKey.get(operationKey) !== replyOperation ||
      replyOperation.key !== operationKey ||
      replyOperation.sessionId !== operationSessionId
    ) {
      throw new Error("Requester continuation lost its original reply operation");
    }
  };
  assertRequesterCurrent();
  let settlementPromise: Promise<void> | undefined;
  const settlement: PendingContinuationSettlement = {
    settle: (statusDelivered) =>
      (settlementPromise ??= (async () => {
        try {
          assertRequesterCurrent();
          // Ordinary replies have no child-registry lifecycle; load only for this captured cohort.
          const { settleRequesterAfterSessionSpawns } =
            await import("../../agents/subagents/registry/subagent-registry.js");
          assertRequesterCurrent();
          const transferred = await settleRequesterAfterSessionSpawns({
            requesterSessionKey,
            requesterAgentId: followupRun.run.agentId,
            requesterTurnRunId: runId,
            acceptedSessionSpawns,
            requesterYielded:
              statusDelivered && resolveReplyOperationAbortReason(replyOperation) === undefined,
            stateContext,
            assertCurrent: assertRequesterCurrent,
          });
          if (!transferred) {
            throw new Error("accepted continuation children could not transfer terminal delivery");
          }
          try {
            assertRequesterCurrent();
          } catch (error) {
            throw new SubagentRegistryWriteError("committed", error, "published");
          }
        } finally {
          if (payload) {
            getReplyPayloadMetadata(payload)?.progressContinuation?.close();
          }
        }
      })().catch((error: unknown) => {
        if (!(error instanceof SubagentRegistryWriteError) || error.outcome === "not-committed") {
          settlementPromise = undefined;
        }
        throw error;
      })),
  };
  opts?.onPendingContinuation?.(settlement);
}
