import { randomUUID } from "node:crypto";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  claimExecApprovalFollowupRuntimeHandoff,
  finalizeExecApprovalFollowupRuntimeHandoff,
  releaseExecApprovalFollowupRuntimeHandoff,
} from "../../agents/bash-tools.exec-approval-followup-state.js";
import {
  buildExecApprovalContinuationPrompt,
  EXEC_APPROVAL_FOLLOWUP_HANDOFF_MESSAGE,
  type ExecApprovalContinuationPromptRange,
} from "../../agents/bash-tools.exec-approval-output.js";
import type { ExecElevatedDefaults } from "../../agents/bash-tools.exec-types.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import type { RuntimeContextFragment } from "../../agents/internal-runtime-context.js";
import type { ReplyExpectation } from "../../agents/reply-completion.js";
import {
  captureRequesterOrigin,
  resolveRequesterPrincipalKey,
  type RequesterOrigin,
} from "../../agents/requester-origin.js";
import { prepareCommandOwnerAuthority } from "../../auto-reply/command-auth.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import { readSessionSubmittedInput } from "../../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { deleteMediaBuffer } from "../../media/store.js";
import {
  annotateInterSessionPromptText,
  isCompletionReportInputProvenance,
  isSubagentCoordinationInputProvenance,
  normalizeInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { readUserTurnRequesterOrigin } from "../../sessions/user-turn-transcript-admission.js";
import { retainsUserTurnTranscriptMedia } from "../../sessions/user-turn-transcript-media.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel-constants.js";
import {
  INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  persistInboundImagesForTranscript,
  type ChatImageContent,
  type OffloadedRef,
} from "../chat-attachments.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { resolveSessionRuntimeCwd } from "../server-methods/agent-session-reset.js";
import { gatewayClientSenderFields } from "../server-methods/gateway-client-identity.js";
import { resolveGatewayInputParticipant } from "../session-input-participant.js";
import { readSessionSendDeliveryAdmission } from "../session-send-delivery.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "../session-utils-store-worker.js";
import { formatForLog } from "../ws-log.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import type { RequesterSettleWakeReplay } from "./internal-facade.types.js";
import type { AgentTurnContext, AgentTurnIo, AgentTurnPrincipal } from "./types.js";

export type PreparedAgentRunUserTurn = {
  privateCompletion?: true;
  /** Trusted input-owner policy; not accepted from the wire request. */
  replyExpectation?: ReplyExpectation;
  bashElevated?: ExecElevatedDefaults;
  claimedExecApprovalFollowupHandoffId?: string;
  execApprovalFollowupHandoffClaimId: string;
  execApprovalContinuationPromptRange?: ExecApprovalContinuationPromptRange;
  message: string;
  runtimeContextFragments?: RuntimeContextFragment[];
  inputProvenance?: InputProvenance;
  recorder?: UserTurnTranscriptRecorder;
  requesterOrigin?: RequesterOrigin;
  assertRequesterCurrent?: () => void;
  senderIsOwner: boolean;
  suppressPromptPersistence: boolean;
  releaseProcessingAbortObserver?: () => void;
};

export function reconcileAgentRunUserTurnCompletion(
  userTurn: PreparedAgentRunUserTurn,
  accepted: { runId: string },
  cleanupPreaccept: () => Promise<void>,
  io: AgentTurnIo,
): Promise<void> | undefined {
  const completion = userTurn.recorder?.getProcessingCompletion?.();
  // No-receipt admission must stay synchronous through ownership transfer;
  // yielding here could accept a run cancelled after its final revalidation.
  if (!completion) {
    return undefined;
  }
  // Durable processing outlives Gateway dedupe. Release the fresh admission
  // before acknowledging the receipt so the parent is never dispatched twice.
  return cleanupPreaccept().then(() => {
    io.emitAcceptance(
      [
        true,
        {
          ...accepted,
          status: completion.status,
          summary: completion.reason,
          ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
          ...(completion.reason === "completed" ? { inputProcessingCompleted: true } : {}),
        },
        undefined,
      ],
      { runId: accepted.runId },
    );
  });
}

export function recordAgentRunUserTurnParticipant(
  params: {
    client: AgentTurnPrincipal | null;
    inputProvenance?: InputProvenance;
    resolvedSessionKey?: string;
    suppressVisibleSessionEffects: boolean;
    promptedAt: number;
    activeSessionAgentId: string;
    context: Pick<AgentTurnContext, "logGateway">;
  },
  userTurn: PreparedAgentRunUserTurn,
  storePath: string,
): void {
  const participant = resolveGatewayInputParticipant(params.client, params.inputProvenance);
  if (
    participant &&
    params.resolvedSessionKey &&
    !params.suppressVisibleSessionEffects &&
    !userTurn.suppressPromptPersistence
  ) {
    recordSessionParticipantBestEffort({
      identity: participant,
      promptedAt: params.promptedAt,
      agentId: params.activeSessionAgentId,
      sessionKey: params.resolvedSessionKey,
      storePath,
      onError: (error) =>
        params.context.logGateway.warn(
          `agent participant persistence failed: ${formatForLog(error)}`,
        ),
    });
  }
}

export async function prepareAgentRunUserTurn(params: {
  assertCurrent: () => void;
  onUserTurnMediaPersisted: () => void;
  assertCompletionCurrent?: () => void;
  privateCompletion?: true;
  replyExpectation?: ReplyExpectation;
  settleWakeReplay?: RequesterSettleWakeReplay;
  abortSignal?: AbortSignal;
  getAbortStopReason?: () => string;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: InternalSessionEntry;
  /** Exact creation target carried only by the host-bound fresh-child admission. */
  freshChildStorePath?: string;
  resolvedSessionKey?: string;
  requestedSessionKeyRaw?: string;
  admittedSessionId: string;
  activeSessionAgentId: string;
  resolvedThreadId?: string | number;
  suppressVisibleSessionEffects: boolean;
  requestedPromptPersistenceSuppression: boolean;
  restoredCronContinuation?: RestoredCronContinuation;
  canUseInternalRuntimeHandoff: boolean;
  execApprovalFollowupApprovalId?: string;
  message: string;
  effectiveTranscriptInputText: string;
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  inputProvenance?: InputProvenance;
  runId: string;
  client: AgentTurnPrincipal | null;
  context: AgentTurnContext;
}): Promise<PreparedAgentRunUserTurn> {
  const caller = params.client?.internal?.agentToolCaller;
  const operatorAuthority = params.client?.internal?.operatorRunAuthority;
  operatorAuthority?.assertCurrent();
  let requesterOrigin = caller
    ? captureRequesterOrigin(caller)
    : operatorAuthority ||
        (params.client?.authenticatedUserProfile && !params.client.internal?.syntheticClient)
      ? captureRequesterOrigin({
          sessionKey: params.resolvedSessionKey,
          operatorProfileId:
            operatorAuthority?.profileId ?? params.client?.authenticatedUserProfile?.profileId,
        })
      : undefined;
  const resolveRuntimeSenderIsOwner = () =>
    Boolean(params.restoredCronContinuation || hasGatewayAdminScope(params.client)) &&
    (!requesterOrigin ||
      Boolean(requesterOrigin.operatorProfileId) ||
      ((!requesterOrigin.messageProvider ||
        requesterOrigin.messageProvider === INTERNAL_MESSAGE_CHANNEL) &&
        !resolveRequesterPrincipalKey({ requesterOrigin }) &&
        params.client?.internal?.operatorRoleActor?.kind === "system"));
  const execApprovalFollowupHandoffClaimId = randomUUID();
  let claimedExecApprovalFollowupHandoffId: string | undefined;
  let createdMediaIds: string[] = [];
  let recorder: UserTurnTranscriptRecorder | undefined;
  try {
    const claimFollowup = (sessionKey: string | undefined) =>
      claimExecApprovalFollowupRuntimeHandoff({
        handoffId: params.request.internalRuntimeHandoffId,
        approvalId: params.execApprovalFollowupApprovalId,
        idempotencyKey: params.runId,
        sessionKey,
        claimId: execApprovalFollowupHandoffClaimId,
      });
    let execApprovalFollowupRuntimeHandoff: ReturnType<typeof claimFollowup>;
    if (params.canUseInternalRuntimeHandoff && params.execApprovalFollowupApprovalId) {
      execApprovalFollowupRuntimeHandoff = claimFollowup(params.resolvedSessionKey);
      if (
        !execApprovalFollowupRuntimeHandoff &&
        params.requestedSessionKeyRaw &&
        params.requestedSessionKeyRaw !== params.resolvedSessionKey
      ) {
        execApprovalFollowupRuntimeHandoff = claimFollowup(params.requestedSessionKeyRaw);
      }
    }
    if (execApprovalFollowupRuntimeHandoff) {
      claimedExecApprovalFollowupHandoffId = params.request.internalRuntimeHandoffId;
    }

    let message = params.message;
    const runtimeContextFragments = params.client?.internal?.runtimeContextFragments;
    let effectiveTranscriptInputText = params.effectiveTranscriptInputText;
    let execApprovalContinuationPromptRange: ExecApprovalContinuationPromptRange | undefined;
    if (execApprovalFollowupRuntimeHandoff?.resultText !== undefined) {
      const continuation = buildExecApprovalContinuationPrompt(
        execApprovalFollowupRuntimeHandoff.resultText,
      );
      message = continuation.message;
      effectiveTranscriptInputText = continuation.message;
      execApprovalContinuationPromptRange = continuation.resultRange;
    } else if (message === EXEC_APPROVAL_FOLLOWUP_HANDOFF_MESSAGE) {
      throw new Error("exec approval followup runtime handoff is unavailable");
    }

    let senderIsOwner = resolveRuntimeSenderIsOwner();
    const settleWakeReplay = params.settleWakeReplay;
    if (
      settleWakeReplay &&
      (!params.runId.startsWith("announce:") ||
        params.inputProvenance?.kind !== "inter_session" ||
        params.inputProvenance.sourceTool !== "subagent_settle" ||
        !params.inputProvenance.sourceSessionKey ||
        !settleWakeReplay.sourceSessionKeys.includes(params.inputProvenance.sourceSessionKey))
    ) {
      throw new Error("Settle replay requires an exact internal frozen-cohort source");
    }
    let inputProvenance = params.inputProvenance;
    if (
      params.privateCompletion &&
      (params.request.deliver !== false ||
        params.request.expectedExistingSessionId !== params.admittedSessionId ||
        !params.runId.startsWith("announce:") ||
        params.inputProvenance?.kind !== "inter_session" ||
        !["subagent_announce", "subagent_settle"].includes(params.inputProvenance.sourceTool ?? ""))
    ) {
      throw new Error(
        "Private completion requires an exact internal requester turn with delivery disabled",
      );
    }
    const trackRequesterCompletion = params.privateCompletion || settleWakeReplay !== undefined;
    const suppressPromptPersistence =
      !params.privateCompletion && params.requestedPromptPersistenceSuppression;
    if (
      params.resolvedSessionKey &&
      !params.suppressVisibleSessionEffects &&
      !suppressPromptPersistence
    ) {
      const persistedMedia = await persistInboundImagesForTranscript({
        images: params.images,
        offloadedRefs: params.offloadedRefs,
        log: params.context.logGateway,
        logContext: "agent",
        assertCurrent: params.assertCurrent,
      });
      // The parser still owns offloaded files until admission retains them.
      // This scope only removes inline files it created, avoiding a second delete.
      createdMediaIds = persistedMedia.entries
        .filter((entry) => entry.imageKind === "inline")
        .map((entry) => entry.id);
      params.assertCurrent();
      const media = persistedMedia.entries.map((entry) => entry.fact);
      const slots = persistedMedia.entries.flatMap((entry, factIndex) =>
        entry.imageKind ? [{ kind: entry.imageKind, factIndex }] : [],
      );
      const resolveTarget = async () => {
        params.assertCurrent();
        const loaded = params.freshChildStorePath
          ? {
              entry: params.sessionEntry,
              storePath: params.freshChildStorePath,
              store: undefined,
            }
          : await loadGatewaySessionEntryReadOnlyInWorker({
              cfg: params.cfgForAgent ?? params.cfg,
              key: params.resolvedSessionKey!,
              agentId: params.activeSessionAgentId,
              assertActive: params.assertCurrent,
              excludeInternalEffects: true,
            });
        params.assertCurrent();
        const latestEntry = loaded.entry;
        const loadedSessionId = latestEntry?.sessionId?.trim();
        // Fresh children carry committed creation facts; their live lease still
        // authorizes the write. Other callers must resolve their current target.
        if (
          !params.freshChildStorePath &&
          (!latestEntry || loadedSessionId !== params.admittedSessionId)
        ) {
          return undefined;
        }
        return {
          sessionId: params.admittedSessionId,
          expectedSessionId: params.admittedSessionId,
          sessionKey: params.resolvedSessionKey!,
          sessionEntry: latestEntry,
          sessionStore: loaded.store,
          storePath: loaded.storePath,
          agentId: params.activeSessionAgentId,
          cwd: resolveSessionRuntimeCwd({ sessionEntry: latestEntry }),
          ...(params.resolvedThreadId != null ? { threadId: params.resolvedThreadId } : {}),
          config: params.cfgForAgent ?? params.cfg,
        };
      };
      const privateTarget = params.privateCompletion ? await resolveTarget() : undefined;
      const senderFields = gatewayClientSenderFields(params.client);
      if (privateTarget) {
        const submitted = await readSessionSubmittedInput(
          privateTarget,
          buildRunUserTurnIdempotencyKey(params.runId),
        );
        params.assertCurrent();
        const sender = senderFields.sender;
        const metadata = submitted?.["__openclaw"];
        if (sender?.id && metadata?.senderId === sender.id) {
          // Profile labels can change after acceptance; replay keeps the recorded
          // presentation while the input owner still compares the complete request.
          senderFields.sender = {
            ...sender,
            name: typeof metadata.senderName === "string" ? metadata.senderName : undefined,
          };
        }
      }
      const input: UserTurnInput = {
        ...(params.privateCompletion ||
        isCompletionReportInputProvenance(params.inputProvenance) ||
        isSubagentCoordinationInputProvenance(params.inputProvenance)
          ? { display: false as const }
          : {}),
        text:
          persistedMedia.omission === "inline-image-save-failed"
            ? [effectiveTranscriptInputText, INLINE_IMAGE_DURABLE_OMISSION_MARKER]
                .filter(Boolean)
                .join("\n")
            : effectiveTranscriptInputText,
        timestamp: Date.now(),
        idempotencyKey: buildRunUserTurnIdempotencyKey(params.runId),
        ...senderFields,
        senderIsOwner,
        requesterOrigin,
        ...(params.inputProvenance ? { provenance: params.inputProvenance } : {}),
        ...(media.length > 0 ? { media } : {}),
        ...(slots.length > 0 ? { mediaImageLayout: { slots } } : {}),
      };
      const peerDelivery = readSessionSendDeliveryAdmission({
        runId: params.runId,
        sessionKey: params.resolvedSessionKey,
        sessionId: params.admittedSessionId,
        agentId: params.activeSessionAgentId,
      });
      recorder = createUserTurnTranscriptRecorder({
        trackInputCompletion: trackRequesterCompletion || peerDelivery !== undefined,
        pendingInputReplaySourceSessionKeys: settleWakeReplay?.sourceSessionKeys,
        input,
        target: params.privateCompletion
          ? () => {
              params.assertCurrent();
              return privateTarget;
            }
          : resolveTarget,
        errorContext: "gateway agent user turn transcript",
        beforeMessageWrite: (writeContext) => {
          const preparedMessage = runAgentHarnessBeforeMessageWriteHook(writeContext);
          params.assertCurrent();
          return preparedMessage;
        },
        onPersistenceError: (error) => {
          params.context.logGateway.warn(
            `gateway agent user transcript persistence failed: ${formatForLog(error)}`,
          );
        },
      });
      if (
        !(await recorder.stageApproved!({
          runId: params.runId,
          // This live, freshly authorized completion can retry; stored Stop/completed receipts win.
          retryCancelled: trackRequesterCompletion,
          storageTarget: params.freshChildStorePath
            ? {
                agentId: params.activeSessionAgentId,
                sessionId: params.admittedSessionId,
                sessionKey: params.resolvedSessionKey,
                storePath: params.freshChildStorePath,
              }
            : undefined,
          assertCurrent: () => {
            params.assertCurrent();
            settleWakeReplay?.assertCurrent();
          },
          assertAdmittedCurrent: params.assertCurrent,
          assertCompletionCurrent: params.assertCompletionCurrent,
        })) &&
        !recorder.getProcessingCompletion?.()
      ) {
        throw new Error("agent turn was not durably admitted");
      }
      // Storage may prove the scheduling source used by a shipped batch. Carry
      // that exact provenance into execution, not only its transcript receipt.
      if (settleWakeReplay) {
        inputProvenance = normalizeInputProvenance(recorder.getPendingInputMessage?.()?.provenance);
      }
      requesterOrigin = readUserTurnRequesterOrigin(recorder) ?? requesterOrigin;
    }

    const requesterOwner =
      requesterOrigin?.messageProvider &&
      requesterOrigin.messageProvider !== INTERNAL_MESSAGE_CHANNEL &&
      !requesterOrigin.operatorProfileId
        ? await prepareCommandOwnerAuthority(params.cfg, {
            channel: requesterOrigin.messageProvider,
            accountId: requesterOrigin.accountId ?? undefined,
            senderId: requesterOrigin.senderId ?? undefined,
            senderE164: requesterOrigin.senderE164 ?? undefined,
          })
        : undefined;
    params.assertCurrent();
    if (requesterOrigin && !requesterOrigin.operatorProfileId) {
      senderIsOwner =
        requesterOwner?.isCurrent(params.cfg) === true || resolveRuntimeSenderIsOwner();
    }
    const assertRequesterCurrent =
      requesterOwner && senderIsOwner
        ? () => {
            if (!requesterOwner.isCurrent(params.context.getRuntimeConfig())) {
              throw new Error("Requester owner authority changed; send a new request.");
            }
          }
        : undefined;
    assertRequesterCurrent?.();

    let releaseProcessingAbortObserver: (() => void) | undefined;
    if (trackRequesterCompletion && recorder && !recorder.getProcessingCompletion?.()) {
      const recordAbort = () => {
        const stopReason = params.getAbortStopReason?.() ?? "rpc";
        // Intentional Stop seals non-retry custody immediately. A timeout
        // retains its source until the producer publishes its actual terminal facts.
        if (stopReason === "timeout") {
          return;
        }
        void completeUserTurnProcessing(
          recorder,
          buildAgentRunTerminalOutcome({ status: "error", stopReason }),
        ).catch((error: unknown) => {
          params.context.logGateway.warn(
            `private input cancellation persistence failed: ${formatForLog(error)}`,
          );
        });
      };
      // Abort reserves terminal ownership before notifying listeners. Record
      // the stop while that exact controller still exists, even after input consumption.
      params.abortSignal?.addEventListener("abort", recordAbort, { once: true });
      releaseProcessingAbortObserver = () =>
        params.abortSignal?.removeEventListener("abort", recordAbort);
      if (params.abortSignal?.aborted) {
        recordAbort();
      }
    }
    return {
      ...(params.privateCompletion ? { privateCompletion: true as const } : {}),
      replyExpectation: params.replyExpectation,
      ...(releaseProcessingAbortObserver ? { releaseProcessingAbortObserver } : {}),
      ...(execApprovalFollowupRuntimeHandoff?.bashElevated
        ? { bashElevated: execApprovalFollowupRuntimeHandoff.bashElevated }
        : {}),
      ...(claimedExecApprovalFollowupHandoffId ? { claimedExecApprovalFollowupHandoffId } : {}),
      execApprovalFollowupHandoffClaimId,
      ...(execApprovalContinuationPromptRange ? { execApprovalContinuationPromptRange } : {}),
      message,
      ...(runtimeContextFragments ? { runtimeContextFragments } : {}),
      inputProvenance,
      ...(recorder ? { recorder } : {}),
      senderIsOwner,
      requesterOrigin,
      assertRequesterCurrent,
      suppressPromptPersistence,
    };
  } catch (error) {
    const mediaRetained = recorder !== undefined && retainsUserTurnTranscriptMedia(recorder);
    if (mediaRetained) {
      // This callback transfers parser cleanup ownership, not a public success fact.
      // Retained input must keep its media even if later preparation or cleanup fails.
      params.onUserTurnMediaPersisted();
    }
    const stopReason = params.getAbortStopReason?.() ?? "rpc";
    const outcome = buildAgentRunTerminalOutcome({ status: "error", stopReason });
    // Pending input must settle before admission can publish an abort. Timeouts
    // retain retry custody; an explicit stop cancels it even before execution.
    const failure = await releasePreparedAgentRunUserTurnAfterFailure(
      { recorder, claimedExecApprovalFollowupHandoffId, execApprovalFollowupHandoffClaimId },
      error,
      params.abortSignal?.aborted && stopReason !== "restart" && outcome.reason === "cancelled"
        ? "cancelled"
        : "interrupted",
    );
    if (!mediaRetained) {
      await Promise.allSettled(createdMediaIds.map((id) => deleteMediaBuffer(id, "inbound")));
    }
    throw failure;
  }
}

export function annotateAgentRunUserTurnPrompt(params: {
  message: string;
  inputProvenance?: InputProvenance;
  execApprovalContinuationPromptRange?: ExecApprovalContinuationPromptRange;
}) {
  const message = annotateInterSessionPromptText(params.message, params.inputProvenance);
  let execApprovalContinuationPromptRange = params.execApprovalContinuationPromptRange;
  if (execApprovalContinuationPromptRange) {
    if (!message.endsWith(params.message)) {
      throw new Error("exec approval continuation prompt range could not be annotated");
    }
    const offset = message.length - params.message.length;
    execApprovalContinuationPromptRange = {
      start: offset + execApprovalContinuationPromptRange.start,
      end: offset + execApprovalContinuationPromptRange.end,
    };
  }
  return { message, execApprovalContinuationPromptRange };
}

export function finalizePreparedAgentRunUserTurn(prepared: PreparedAgentRunUserTurn): void {
  const handoffId = prepared.claimedExecApprovalFollowupHandoffId;
  if (!handoffId) {
    return;
  }
  if (
    !finalizeExecApprovalFollowupRuntimeHandoff({
      handoffId,
      claimId: prepared.execApprovalFollowupHandoffClaimId,
    })
  ) {
    throw new Error("exec approval followup runtime handoff expired before dispatch");
  }
}

export async function releasePreparedAgentRunUserTurn(
  prepared: Pick<
    PreparedAgentRunUserTurn,
    | "recorder"
    | "releaseProcessingAbortObserver"
    | "claimedExecApprovalFollowupHandoffId"
    | "execApprovalFollowupHandoffClaimId"
  >,
  disposition: "cancelled" | "interrupted" = "cancelled",
): Promise<void> {
  try {
    prepared.releaseProcessingAbortObserver?.();
    prepared.recorder?.finishPendingInput?.(disposition);
  } finally {
    try {
      await prepared.recorder?.waitForPendingInputSettlement?.();
    } finally {
      releaseExecApprovalFollowupRuntimeHandoff({
        handoffId: prepared.claimedExecApprovalFollowupHandoffId,
        claimId: prepared.execApprovalFollowupHandoffClaimId,
      });
    }
  }
}

/** A recorded abort cannot replace a failed custody settlement. */
export class AgentRunUserTurnCleanupError extends AggregateError {
  constructor(error: unknown, cleanupError: unknown) {
    super(
      [error, cleanupError],
      `${formatForLog(error)}; pending input cleanup failed: ${formatForLog(cleanupError)}`,
    );
  }
}

/** Settles failed input while preserving both admission and settlement failures. */
export async function releasePreparedAgentRunUserTurnAfterFailure(
  prepared: Parameters<typeof releasePreparedAgentRunUserTurn>[0],
  error: unknown,
  disposition: "cancelled" | "interrupted" = "cancelled",
): Promise<unknown> {
  try {
    await releasePreparedAgentRunUserTurn(prepared, disposition);
    return error;
  } catch (cleanupError) {
    return new AgentRunUserTurnCleanupError(error, cleanupError);
  }
}
