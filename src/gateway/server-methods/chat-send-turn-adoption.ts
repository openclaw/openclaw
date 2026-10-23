import { resolveAgentRunAbortLifecycleFields } from "../../agents/run-termination.js";
import type { TurnAdoptionLifecycle } from "../../auto-reply/get-reply-options.types.js";
import type {
  QueuedFollowupReplyBatch,
  QueuedFollowupReplyDelivery,
} from "../../auto-reply/reply/queue/types.js";
import { bindReplySourceInput } from "../../auto-reply/reply/reply-source-binding.js";
import { retireSessionControllerSourceCancellation } from "../../sessions/session-controller.mailbox.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  isRpcSourceRegistered,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureAgentJobSession, setGatewayDedupeEntry } from "../agent-turn/agent-job.js";
import {
  captureChatAbortRegistrationGuard,
  markChatAbortTerminalOutcome,
} from "../chat-abort-lifecycle-internal.js";
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
  sourceRef: RpcSourceRef;
  context: GatewayRequestContext;
  runId: string;
  controller: AbortController;
  sessionKey: string;
  agentId?: string;
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
  let terminalKnown = false;
  let steered = false;
  const ownsQueueIdentity = captureChatAbortRegistrationGuard([
    { runId: params.runId, entry: params.sourceRef },
  ]);
  let settlementRecorded = false;
  let releaseWorkAdmission: (() => void) | undefined;
  type Completion = Exclude<QueuedFollowupReplyBatch["completion"], { kind: "progress" }>;
  const recordQueuedTerminal = (completion: Completion, publish = false) => {
    if (terminalKnown || !ownsQueueIdentity()) {
      return;
    }
    const runProjection = params.context.chatRunState.runs.get(params.runId);
    terminalKnown = true;
    markChatAbortTerminalOutcome(params.sourceRef);
    const now = Date.now();
    const failed = completion.kind === "failed";
    try {
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `chat:${params.runId}`,
        session: captureAgentJobSession({
          ...getRpcSourceIdentity(params.sourceRef),
          lifecycleGeneration: getRpcSourceLifecycleGeneration(params.sourceRef),
        }),
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
          terminalEntry: params.sourceRef,
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
    } finally {
      if (
        ownsQueueIdentity() &&
        params.context.chatRunState.runs.get(params.runId) === runProjection
      ) {
        params.context.chatRunState.clearRun(params.runId);
      }
    }
  };
  const recordQueuedAbort = (publish: boolean) =>
    recordQueuedTerminal(
      {
        kind: "aborted",
        stopReason:
          params.sourceRef.adapter.abortStopReason ??
          resolveAgentRunAbortLifecycleFields(params.controller.signal).stopReason,
      },
      publish,
    );
  const finalizeReply = params.suppressReplies
    ? undefined
    : createChatSendLateReplyFinalizer({
        terminalEntry: params.sourceRef,
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
      if (
        batch.clientRunId === params.runId &&
        batch.completion.kind !== "progress" &&
        batch.isCurrent() &&
        ownsQueueIdentity()
      ) {
        markChatAbortTerminalOutcome(params.sourceRef);
      }
      try {
        const result = finalizeReply
          ? await finalizeReply({
              ...batch,
              isCurrent: () =>
                batch.isCurrent() &&
                ownsQueueIdentity() &&
                (batch.clientRunId !== params.runId || !terminalKnown),
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
  const priorCancel = params.sourceRef.adapter.cancel?.bind(params.sourceRef.adapter);
  params.sourceRef.adapter.cancel = (reason) => {
    priorCancel?.(reason);
    // Active execution publishes its own terminal outcome; only queued, unadopted
    // input is settled here when the controller cancels it.
    if (params.sourceRef.input.custody.enqueued && !params.sourceRef.input.custody.adopted) {
      recordQueuedAbort(params.sourceRef.adapter.projectSessionTerminalPending !== true);
    }
  };
  const lifecycle: TurnAdoptionLifecycle = {
    // Gateway cancel identity only — share collect key via ownerKey.
    admission: "cancel-only",
    abortSignal: params.sourceRef.input.abortSignal,
    ...(params.originatingLeafEntryId !== undefined
      ? { originatingLeafEntryId: params.originatingLeafEntryId }
      : {}),
    ownerKey: params.ownerKey,
    onAdopted: () => {
      params.sourceRef.input.abortSignal.throwIfAborted();
    },
    onDeferred: () => {
      if (params.hasCronCreatorAuthority) {
        lifecycle.cronCreatorAuthorityUnavailable = "queued-local-operator";
      }
      const input = params.sourceRef.input;
      if (
        !isRpcSourceRegistered(params.sourceRef) ||
        input.abortSignal.aborted ||
        input.phase === "consumed"
      ) {
        return false;
      }
      // The controller owns queue selection; retain only physical publication custody.
      releaseWorkAdmission ??= params.retainWorkAdmission();
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `chat:${params.runId}`,
        session: captureAgentJobSession({
          ...getRpcSourceIdentity(params.sourceRef),
          lifecycleGeneration: getRpcSourceLifecycleGeneration(params.sourceRef),
        }),
        entry: { ts: Date.now(), ok: true, payload: { runId: params.runId, status: "accepted" } },
      });
      lateFollowup.recordQueued();
      params.armOperatorRunCancellation?.();
      return true;
    },
    onCancellationRetired: () => {
      retireSessionControllerSourceCancellation(params.sourceRef.input);
      params.retireOperatorRunCancellation?.();
    },
    onAbandoned: () => {
      // Direct dispatch owns preparation failures before source adoption.
      if (!params.sourceRef.input.custody.enqueued) {
        return;
      }
      recordQueuedTerminal(
        { kind: "aborted", stopReason: "aborted" },
        params.sourceRef.adapter.projectSessionTerminalPending !== true,
      );
    },
    onSettled: () => {
      if (settlementRecorded) {
        return;
      }
      settlementRecorded = true;
      try {
        if (!params.sourceRef.input.custody.enqueued || !ownsQueueIdentity()) {
          return;
        }
        params.retireOperatorRunCancellation?.();
        if (!terminalKnown && params.controller.signal.aborted) {
          recordQueuedAbort(params.sourceRef.adapter.projectSessionTerminalPending !== true);
        }
        // Consumed steering returns its receipt to the still-running source dispatch.
        if (!terminalKnown) {
          steered = true;
        }
      } finally {
        releaseWorkAdmission?.();
        releaseWorkAdmission = undefined;
      }
    },
  };
  bindReplySourceInput(lifecycle, params.sourceRef.input);
  const priorSettled = params.sourceRef.adapter.onSettled?.bind(params.sourceRef.adapter);
  params.sourceRef.adapter.onSettled = async () => {
    try {
      await lifecycle.onSettled?.();
    } finally {
      await priorSettled?.();
    }
  };
  return {
    lifecycle,
    isEnqueued: () => !steered && params.sourceRef.input.custody.enqueued === true,
    isTerminal: () => terminalKnown,
    isSteered: () => steered,
    onRunStarted: (runId) => {
      if (
        params.sourceRef.input.custody.enqueued &&
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
