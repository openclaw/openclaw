import type { AcceptedSessionSpawn } from "../../agents/accepted-session-spawn.js";
import { adoptMediaGenerationProgressDraft } from "../../agents/media-generation-activity.js";
import { isRequiredReplyExpectation, type ReplyCompletion } from "../../agents/reply-completion.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  SubagentRegistryWriteError,
} from "../../agents/subagents/registry/subagent-registry-persistence.js";
import type { ProgressContinuationCapability } from "../../channels/progress-continuation.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import type { PendingContinuationSettlement } from "./get-reply.types.js";
import { resolveReplyOperationAbortReason } from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";
import { replyRunState } from "./reply-run-registry.state.js";

export function buildWaitingStatusPayload(params: {
  completion: ReplyCompletion;
  continuationPending?: boolean;
  mediaContinuation?: boolean;
  yieldAcknowledgment?: string;
  yielded?: boolean;
  hasVisibleMessageDelivery: boolean;
}): ReplyPayload | undefined {
  const text =
    params.yieldAcknowledgment?.trim() ||
    (params.mediaContinuation
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
async function attachWaitingStatusProgressContinuation(params: {
  payload: ReplyPayload;
  acceptedSessionSpawns?: readonly AcceptedSessionSpawn[];
  /** Set only for a media continuation, which has no completion child. */
  mediaRequester?: { sessionKey: string; agentId?: string };
  operation: ReplyOperation;
}): Promise<void> {
  const { acceptedSessionSpawns, mediaRequester, operation } = params;
  let adoptDraft: ProgressContinuationCapability["adopt"];
  if (mediaRequester) {
    adoptDraft = (draft) =>
      adoptMediaGenerationProgressDraft(mediaRequester.sessionKey, mediaRequester.agentId, draft);
  } else if (acceptedSessionSpawns?.length) {
    // Ordinary replies must not load the subagent registry.
    const { adoptSubagentProgressDraft } =
      await import("../../agents/subagents/registry/subagent-progress-draft.js");
    adoptDraft = (draft) => adoptSubagentProgressDraft(acceptedSessionSpawns, draft);
  } else {
    return;
  }
  let open = true;
  setReplyPayloadMetadata(params.payload, {
    progressContinuation: {
      adopt: (draft) =>
        open && resolveReplyOperationAbortReason(operation) === undefined && adoptDraft(draft),
      close: () => {
        open = false;
      },
    },
  });
}

export async function prepareWaitingStatusContinuation(params: {
  context: Pick<
    FinalizeReplyAgentRunInput,
    | "execution"
    | "followupRun"
    | "opts"
    | "replyOperation"
    | "runId"
    | "runtimePolicySessionKey"
    | "sessionKey"
  >;
  payload?: ReplyPayload;
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
  if (payload) {
    await attachWaitingStatusProgressContinuation({
      payload,
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
