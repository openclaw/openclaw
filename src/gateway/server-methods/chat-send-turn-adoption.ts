import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import type { QueuedFollowupReplyDelivery } from "../../auto-reply/reply/queue/types.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import {
  completeQueuedChatTurn,
  registerQueuedChatTurn,
  retireQueuedChatTurnCancellation,
  type QueuedChatTurnMap,
} from "../chat-queued-turns.js";
import { buildAbortedChatSendPayload } from "./chat-abort-authorization.js";
import type { WebchatReplyMediaRequesterContext } from "./chat-reply-media.js";
import { createChatSendLateFollowupDisposition } from "./chat-send-late-followup.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { createChatSendLateReplyFinalizer } from "./chat-send-source-finalization.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
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
  >;
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
  retainWorkAdmission: () => () => void;
  armOperatorRunCancellation?: () => void;
  retireOperatorRunCancellation?: () => void;
}): {
  lifecycle: TurnAdoptionLifecycle;
  isEnqueued: () => boolean;
  isCompleted: () => boolean;
  onQueueDisposition: (reason: string) => void;
  onQueuedFollowupReplyBatch: QueuedFollowupReplyDelivery;
} {
  let enqueued = false;
  let terminalKnown = false;
  let completed = false;
  let releaseWorkAdmission: (() => void) | undefined;
  const recordRefreshTerminal = (status: "completed" | "aborted") => {
    if (!params.suppressReplies) {
      return;
    }
    const now = Date.now();
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key: `chat:${params.runId}`,
      session: captureAgentJobSession(params.sessionBinding),
      entry: {
        ts: now,
        ok: true,
        payload:
          status === "aborted"
            ? buildAbortedChatSendPayload({ runId: params.runId, endedAt: now })
            : { runId: params.runId, status },
      },
    });
  };
  const lateFollowup = createChatSendLateFollowupDisposition({
    runId: params.runId,
    originatingChannel: params.originatingChannel,
    logGateway: params.context.logGateway,
    deliver: params.suppressReplies
      ? async ({ completion }) => {
          terminalKnown ||= completion.kind !== "progress";
          return { kind: "dropped" as const, reason: "no-visible-content" as const };
        }
      : createChatSendLateReplyFinalizer({
          requesterContext: params.requesterContext,
          abortSignal: params.controller.signal,
          accountId: params.accountId,
          context: params.context,
          session: params.session,
        }),
  });
  const lifecycle: TurnAdoptionLifecycle = {
    // Gateway cancel identity only — share collect key via ownerKey.
    admission: "cancel-only",
    abortSignal: params.controller.signal,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
    ownerKey: params.ownerKey,
    onAdopted: async () => {},
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
        ownerConnId: normalizeOptionalChatText(params.ownerConnId),
        ownerDeviceId: normalizeOptionalChatText(params.ownerDeviceId),
        onAborted: () => recordRefreshTerminal("aborted"),
      });
      if (enqueued && !releaseWorkAdmission) {
        // Retain the session fence until this detached queued ownership ends.
        releaseWorkAdmission = params.retainWorkAdmission();
      }
      if (enqueued) {
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
      terminalKnown = true;
    },
    onSettled: () => {
      const ownsCompletion = completeQueuedChatTurn(
        params.chatQueuedTurns,
        params.runId,
        params.controller,
      );
      // Consumed steering also settles custody, but has no terminal batch. Only
      // the exact queued owner can retire an executed or abandoned refresh.
      completed = ownsCompletion && terminalKnown;
      try {
        if (ownsCompletion) {
          params.retireOperatorRunCancellation?.();
        }
        if (completed) {
          recordRefreshTerminal("completed");
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
    isCompleted: () => completed,
    onQueueDisposition: (reason) => {
      params.context.logGateway.info("chat queue turn intentionally skipped", {
        runId: params.runId,
        sessionKey: params.sessionKey,
        outcome: "skipped",
        reason,
      });
    },
    onQueuedFollowupReplyBatch: lateFollowup.deliver,
  };
}
