import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import type {
  QueuedFollowupReplyBatch,
  QueuedFollowupReplyDelivery,
} from "../../auto-reply/reply/queue/types.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import { broadcastChatTerminal } from "./chat-broadcast.js";
import type { WebchatReplyMediaRequesterContext } from "./chat-reply-media.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { createChatSendLateReplyFinalizer } from "./chat-send-source-finalization.js";
import type { GatewayRequestContext } from "./types.js";

export function createChatSendTurnAdoptionLifecycle(params: {
  requesterContext?: WebchatReplyMediaRequesterContext;
  accountId: string | undefined;
  chatQueuedTurns: QueuedChatTurnMap;
  context: GatewayRequestContext;
  runId: string;
  controller: AbortController;
  sessionBinding: Readonly<
    Pick<ChatAbortControllerEntry, "sessionKey" | "sessionId" | "agentId" | "lifecycleGeneration">
  > &
    Pick<ChatAbortControllerEntry, "abortDiagnosticReason" | "abortStopReason">;
  sessionKey: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  ownerKey?: string;
  originatingLeafEntryId?: string | null;
  originatingChannel: string;
  session: Pick<
    PreparedChatSendSession,
    "agentId" | "backingSessionId" | "cfg" | "clientRunId" | "sessionKey" | "sessionLoadOptions"
  >;
  hasCronCreatorAuthority: boolean;
  suppressReplies?: boolean;
  releaseSourceWorkAdmission: () => void;
  retainWorkAdmission: () => () => void;
  armOperatorRunCancellation?: () => void;
  retireOperatorRunCancellation?: () => void;
}): {
  lifecycle: TurnAdoptionLifecycle;
  isEnqueued: () => boolean;
  isTerminal: () => boolean;
  isSteered: () => boolean;
  onRunStarted: (runId: string) => void;
  onQueueDisposition: (reason: string) => void;
  onQueuedFollowupReplyBatch: QueuedFollowupReplyDelivery;
} {
  let enqueued = false;
  let terminalKnown = false;
  let steered = false;
  const ownsQueueIdentity = () => {
    const current = params.chatQueuedTurns.get(params.runId);
    return !current || current.controller === params.controller;
  };
  let adoptionStarted = false;
  let withdrawalHold: Deferred | undefined;
  let releaseWorkAdmission: (() => void) | undefined;
  const holdPendingInputWithdrawal = () => {
    if (adoptionStarted || withdrawalHold || params.controller.signal.aborted) {
      return undefined;
    }
    const hold = createDeferredCore();
    withdrawalHold = hold;
    return () => {
      if (withdrawalHold === hold) {
        withdrawalHold = undefined;
      }
      hold.resolve();
    };
  };
  const admitted = params.context.chatAbortControllers.get(params.runId);
  if (admitted === params.sessionBinding && admitted.controller === params.controller) {
    admitted.holdPendingInputWithdrawal = holdPendingInputWithdrawal;
  }
  type Completion = Exclude<QueuedFollowupReplyBatch["completion"], { kind: "progress" }>;
  const recordQueuedTerminal = (completion: Completion, publish = false) => {
    if (terminalKnown || !ownsQueueIdentity()) {
      return;
    }
    terminalKnown = true;
    const now = Date.now();
    const failed = completion.kind === "failed";
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${params.runId}`,
      session: captureAgentJobSession(params.sessionBinding),
      entry: {
        ts: now,
        ok: !failed,
        payload:
          completion.kind === "aborted"
            ? buildAbortedChatSendPayload({
                runId: params.runId,
                endedAt: now,
                stopReason: completion.stopReason,
              })
            : {
                runId: params.runId,
                status: failed ? (completion.errorKind ?? "error") : "completed",
                endedAt: now,
                stopReason: completion.stopReason,
                ...(failed ? { summary: completion.error } : {}),
              },
      },
    });
    if (publish && !params.suppressReplies) {
      broadcastChatTerminal({
        context: params.context,
        runId: params.runId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        stopReason: completion.stopReason,
        ...(failed
          ? { state: "error", errorMessage: completion.error, errorKind: completion.errorKind }
          : { state: completion.kind === "aborted" ? "aborted" : "final" }),
      });
    }
  };
  const recordQueuedAbort = (publish: boolean) =>
    recordQueuedTerminal(
      {
        kind: "aborted",
        stopReason:
          params.sessionBinding.abortStopReason ??
          resolveAgentRunAbortLifecycleFields(params.controller.signal).stopReason,
      },
      publish,
    );
  const finalizeReply = params.suppressReplies
    ? undefined
    : createChatSendLateReplyFinalizer({
        requesterContext: params.requesterContext,
        abortSignal: params.controller.signal,
        accountId: params.accountId,
        context: params.context,
        session: params.session,
      });
  const lateFollowup = createChatSendLateFollowupDisposition({
    runId: params.runId,
    originatingChannel: params.originatingChannel,
    logGateway: params.context.logGateway,
    onTerminalDrop: (completion) => recordQueuedTerminal(completion, true),
    deliver: async (batch) => {
      try {
        const result = finalizeReply
          ? await finalizeReply({
              ...batch,
              isCurrent: () => batch.isCurrent() && ownsQueueIdentity(),
            })
          : { kind: "dropped" as const, reason: "no-visible-content" as const };
        if (batch.clientRunId === params.runId && batch.completion.kind !== "progress") {
          recordQueuedTerminal(batch.completion);
        }
        return result;
      } catch (error) {
        if (batch.clientRunId === params.runId && batch.completion.kind !== "progress") {
          recordQueuedTerminal({ kind: "failed", error: String(error) });
        }
        throw error;
      }
    },
  });
  const lifecycle: TurnAdoptionLifecycle = {
    // Gateway cancel identity only — share collect key via ownerKey.
    admission: "cancel-only",
    abortSignal: params.controller.signal,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
    ownerKey: params.ownerKey,
    onAdopted: async () => {
      adoptionStarted = true;
      if (withdrawalHold) {
        await withdrawalHold.promise;
      }
      params.controller.signal.throwIfAborted();
    },
    onDeferred: () => {
      if (params.hasCronCreatorAuthority) {
        lifecycle.cronCreatorAuthorityUnavailable = "queued-local-operator";
      }
      enqueued = registerQueuedChatTurn({
        chatQueuedTurns: params.chatQueuedTurns,
        runId: params.runId,
        controller: params.controller,
        sessionId: params.sessionBinding.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        ownerConnId: normalizeOptionalString(params.ownerConnId),
        ownerDeviceId: normalizeOptionalString(params.ownerDeviceId),
        holdPendingInputWithdrawal,
        // Queue cancellation supersedes the source run's earlier custody acknowledgement.
        onAborted: (reason) => {
          params.sessionBinding.abortDiagnosticReason = reason;
          if (!adoptionStarted) {
            recordQueuedAbort(!params.context.chatAbortControllers.has(params.runId));
          }
          params.releaseSourceWorkAdmission();
          releaseWorkAdmission?.();
          releaseWorkAdmission = undefined;
        },
      });
      if (enqueued && !releaseWorkAdmission) {
        // Retain the session fence until this detached queued ownership ends.
        releaseWorkAdmission = params.retainWorkAdmission();
      }
      if (enqueued) {
        setGatewayDedupeEntry({
          dedupe: params.context.dedupe,
          key: `chat:${params.runId}`,
          session: captureAgentJobSession(params.sessionBinding),
          entry: { ts: Date.now(), ok: true, payload: { runId: params.runId, status: "accepted" } },
        });
        lateFollowup.recordQueued();
        params.armOperatorRunCancellation?.();
      }
      return enqueued;
    },
    onCancellationRetired: () => {
      if (
        retireQueuedChatTurnCancellation(params.chatQueuedTurns, params.runId, params.controller)
      ) {
        params.retireOperatorRunCancellation?.();
      }
    },
    onAbandoned: () => {
      recordQueuedTerminal({ kind: "aborted", stopReason: "aborted" }, true);
    },
    onSettled: () => {
      if (admitted?.holdPendingInputWithdrawal === holdPendingInputWithdrawal) {
        admitted.holdPendingInputWithdrawal = undefined;
      }
      const ownsCompletion = completeQueuedChatTurn(
        params.chatQueuedTurns,
        params.runId,
        params.controller,
      );
      try {
        if (ownsCompletion) {
          params.retireOperatorRunCancellation?.();
        }
        if (
          !terminalKnown &&
          params.controller.signal.aborted &&
          (params.suppressReplies || !params.context.chatAbortControllers.has(params.runId))
        ) {
          recordQueuedAbort(true);
        }
        // Steering returns its receipt or error to the still-running source dispatch.
        if (ownsCompletion && !terminalKnown) {
          enqueued = false;
          steered = true;
        }
      } finally {
        releaseWorkAdmission?.();
        releaseWorkAdmission = undefined;
      }
    },
  };
  return {
    lifecycle,
    isEnqueued: () => enqueued,
    isTerminal: () => terminalKnown,
    isSteered: () => steered,
    onRunStarted: (runId) => {
      if (
        enqueued &&
        !terminalKnown &&
        ownsQueueIdentity() &&
        lateFollowup.deliver.ownsCompletion(params.originatingChannel)
      ) {
        params.context.addChatRun(runId, {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          clientRunId: params.runId,
        });
      }
    },
    onQueueDisposition: (reason) => {
      recordQueuedTerminal(
        { kind: "failed", error: `Queued input was dropped (${reason}).` },
        true,
      );
      params.context.logGateway.info("chat queue turn intentionally skipped", {
        runId: params.runId,
        sessionKey: params.sessionKey,
        outcome: "skipped",
        reason,
      });
    },
    onQueuedFollowupReplyBatch: Object.assign(async (batch: QueuedFollowupReplyBatch) => {
      if (!terminalKnown && ownsQueueIdentity()) {
        await lateFollowup.deliver(batch);
      }
    }, lateFollowup.deliver),
  };
}
