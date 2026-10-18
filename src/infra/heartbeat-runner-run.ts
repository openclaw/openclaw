import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { prepareReplyConversation } from "../auto-reply/reply/prompt-session-context.js";
import {
  REPLY_OPERATION_RUN_STATE,
  resolveReplyOperationAgentTurn,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { withReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { parseSessionDeliveryRoute } from "../routing/session-key.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { formatErrorMessage } from "./errors.js";
import { execRequestAbortSignal, readExecRequestOwners } from "./exec-request-context.js";
import {
  resolveHeartbeatIntervalMs,
  resolveHeartbeatTimeoutOverrideSeconds,
} from "./heartbeat-config.js";
import { createHeartbeatDispatch, deliverHeartbeatDispatch } from "./heartbeat-dispatch.js";
import { emitHeartbeatEvent, resolveIndicatorType } from "./heartbeat-events.js";
import { heartbeatLog } from "./heartbeat-log.js";
import {
  isHeartbeatTypingEnabled,
  resolveHeartbeatChannelPlugin,
  resolveHeartbeatTypingIntervalSeconds,
} from "./heartbeat-runner-config.js";
import {
  prepareHeartbeatRunStage,
  resolveHeartbeatWakeStage,
  type HeartbeatRunOptions,
} from "./heartbeat-runner-execution.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import {
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_CHANNEL_NOT_READY,
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import {
  markSessionEventWakeWorkStarted,
  retireRefusedSessionEventWakePoll,
} from "./session-event-wake.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  peekSystemEventEntries,
  type SystemEvent,
} from "./system-events.js";

export async function runHeartbeatOnce(opts: HeartbeatRunOptions): Promise<HeartbeatRunResult> {
  const wake = await resolveHeartbeatWakeStage(opts);
  if (wake.kind === "skipped") {
    return { status: "skipped", reason: wake.reason };
  }
  // Preparation can admit isolated work; later busy skips must retain the occurrence.
  markSessionEventWakeWorkStarted(
    wake.isAmbientPoll
      ? (opts.scheduledEveryMs ??
          resolveHeartbeatIntervalMs(wake.cfg, undefined, wake.heartbeat) ??
          undefined)
      : undefined,
  );
  const prepared = await prepareHeartbeatRunStage(wake);
  if (prepared.kind === "skipped") {
    return { status: "skipped", reason: prepared.reason };
  }
  const { cfg, agentId, heartbeat, startedAt } = wake;
  const { delivery, visibility, sender, runSessionKey, suppressOriginatingContext } = prepared;
  if (!visibility.showAlerts && !visibility.showOk && !visibility.useIndicator) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: "alerts-disabled",
      durationMs: Date.now() - startedAt,
      channel: delivery.channel !== "none" ? delivery.channel : undefined,
      accountId: delivery.accountId,
    });
    return { status: "skipped", reason: "alerts-disabled" };
  }
  const channel = delivery.channel !== "none" ? delivery.channel : undefined;
  const readiness =
    wake.isAmbientPoll && channel && delivery.to
      ? await resolveHeartbeatChannelPlugin(channel)
          ?.heartbeat?.checkReady?.({ cfg, accountId: delivery.accountId, deps: opts.deps })
          .catch((error: unknown) => ({ ok: false, reason: formatErrorMessage(error) }))
      : undefined;
  if (readiness && !readiness.ok) {
    emitHeartbeatEvent({
      status: "skipped",
      reason: readiness.reason,
      channel,
      accountId: delivery.accountId,
      durationMs: Date.now() - startedAt,
    });
    return { status: "skipped", reason: HEARTBEAT_SKIP_CHANNEL_NOT_READY };
  }
  // Message tools infer external destinations from encoded session routes.
  const sourceRoute = parseSessionDeliveryRoute(runSessionKey);
  const internalSource =
    prepared.run.kind === "shared" &&
    delivery.channel === "none" &&
    (!sourceRoute || sourceRoute.channel === INTERNAL_MESSAGE_CHANNEL)
      ? prepared.internalProjection
      : undefined;
  const sourceScope = internalSource
    ? { agentId, storePath: prepared.storePath, ...internalSource }
    : undefined;
  let releaseSource: (() => void) | undefined;
  const policy = createHeartbeatDispatch(opts, wake, prepared);
  const state: ReplyOperationRunState = {
    heartbeat: policy,
    sessionEventDelivery: prepared.canRelayToUser ? undefined : false,
  };
  const execRequestOwners = [
    ...new Set(
      prepared.inspectedSystemEventsToConsume.flatMap(
        (event) => readExecRequestOwners(event) ?? [],
      ),
    ),
  ];
  const cancelledExecResult = (): HeartbeatRunResult | undefined =>
    execRequestOwners.some((owner) => owner.signal.aborted)
      ? {
          status: "skipped",
          reason: peekSystemEventEntries(resolveSystemEventQueueKey(prepared.sessionKey, agentId))
            .length
            ? "preempted"
            : HEARTBEAT_SKIP_NO_PENDING_EVENT,
        }
      : undefined;
  const cancelledBeforeDispatch = cancelledExecResult();
  if (cancelledBeforeDispatch) {
    return cancelledBeforeDispatch;
  }
  const retireRefusedPoll = (result: HeartbeatRunResult) => {
    if (
      result.status === "skipped" &&
      result.reason === "requests-in-flight" &&
      (state.admission === undefined || state.admission.status === "skipped") &&
      prepared.run.kind !== "isolated" &&
      wake.preflight.pendingEventEntries.length === 0 &&
      wake.scheduledTasks.length === 0
    ) {
      retireRefusedSessionEventWakePoll();
    }
    return result;
  };
  const settledResult = () => {
    const result = cancelledExecResult() ?? policy.result;
    return result && retireRefusedPoll(result);
  };
  const signal = execRequestAbortSignal(execRequestOwners, getHeartbeatWakeAbortSignal());
  const eventQueueKey = resolveSystemEventQueueKey(prepared.sessionKey, agentId);
  const deferredGenericIds = new Set(prepared.deferredGenericEvents.map((event) => event.id));
  // Ordinary generic events normally settle at prompt admission. Defer this batch
  // only until its request outcome is known, without changing other error exits.
  const ordinaryGenericIds = new Set(
    execRequestOwners.length > 0 && prepared.inspectsRunQueue
      ? prepared.genericEvents
          .filter((event) => event.id && !deferredGenericIds.has(event.id))
          .map((event) => event.id)
      : [],
  );
  const admittedGenericEvents: SystemEvent[] = [];
  const typing =
    channel &&
    isHeartbeatTypingEnabled({
      cfg,
      agentId,
      hasChatDelivery: Boolean(delivery.to && (visibility.showAlerts || visibility.showOk)),
    })
      ? createHeartbeatTypingCallbacks({
          cfg,
          target: { ...delivery, channel },
          plugin: resolveHeartbeatChannelPlugin(channel),
          deps: opts.deps,
          typingIntervalSeconds: resolveHeartbeatTypingIntervalSeconds(cfg),
          log: heartbeatLog,
        })
      : undefined;
  try {
    let assertSourceCurrent: SessionSourceAssertion | undefined;
    if (sourceScope) {
      const { prepareSessionMutationFacts } =
        await import("../gateway/session-sharing-preparation.js");
      const facts = await prepareSessionMutationFacts({
        cfg,
        agentId,
        sessionKey: sourceScope.sessionKey,
      });
      releaseSource = facts.release;
      const refuse = (): never => {
        throw new Error("heartbeat source generation changed before reply admission");
      };
      const assertGeneration = () => {
        const { target } = facts.readCurrent(cfg);
        if (
          target.storePath !== sourceScope.storePath ||
          target.canonicalKey !== sourceScope.sessionKey ||
          target.entry.sessionId !== sourceScope.sessionId ||
          target.entry.lifecycleRevision !== sourceScope.lifecycleRevision
        ) {
          refuse();
        }
      };
      assertGeneration();
      const { captureSessionEntrySourceAssertion } =
        await import("../config/sessions/session-entry-source-authority.js");
      assertSourceCurrent = captureSessionEntrySourceAssertion({
        scope: sourceScope,
        readSource: facts.readCurrent(cfg).target.readSource,
        expected: sourceScope,
        fields: ["sessionId", "lifecycleRevision"],
        assertCurrent: assertGeneration,
        assertHostCurrent: assertGeneration,
        refuse,
      });
    }
    const { dispatchInboundMessageWithRoutedChannelDispatcher } =
      await import("../auto-reply/dispatch.js");
    await typing?.onReplyStart();
    signal?.throwIfAborted();
    const heartbeatContext = {
      Body: appendCronStyleCurrentTimeLine(prepared.prompt, cfg, startedAt),
      From: sender,
      To: !suppressOriginatingContext ? delivery.to : undefined,
      OriginatingChannel: !suppressOriginatingContext ? channel : undefined,
      OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
      AccountId: delivery.accountId,
      ChatType: delivery.chatType,
      MessageThreadId: delivery.threadId,
      // Internal delivery records have no external route. Carry the admitted
      // WebChat source into prompts and tools instead of the heartbeat placeholder.
      ...(internalSource
        ? {
            Provider: INTERNAL_MESSAGE_CHANNEL,
            Surface: INTERNAL_MESSAGE_CHANNEL,
            OriginatingChannel: INTERNAL_MESSAGE_CHANNEL,
            OriginatingTo: internalSource.sessionKey,
            To: internalSource.sessionKey,
            ChatType: "direct",
          }
        : {}),
      InternalTurnSource: prepared.hasExecCompletion
        ? "exec"
        : prepared.hasCronEvents
          ? "cron"
          : "heartbeat",
      InputProvenance: {
        kind: "internal_system",
        sourceTool: prepared.hasExecCompletion
          ? "exec"
          : prepared.hasCronEvents
            ? "cron"
            : opts.intent === "scheduled" ||
                !wake.wakeSource ||
                wake.wakeSource === "interval" ||
                wake.wakeSource === "manual"
              ? "heartbeat"
              : wake.wakeSource,
      },
      SessionKey: runSessionKey,
      AgentId: agentId,
    } satisfies MsgContext;
    const dispatch = () =>
      dispatchInboundMessageWithRoutedChannelDispatcher({
        cfg,
        ctx: heartbeatContext,
        replyResolver: opts.deps?.getReplyFromConfig,
        suppressOutboundHooks: true,
        replyOptions: withReplySystemEventContext<InternalGetReplyOptions>(
          {
            isHeartbeat: true,
            useHeartbeatFailureCopy: prepared.useHeartbeatFailureCopy,
            requireExplicitMessageTarget: !internalSource,
            // Isolated heartbeats mint a fresh session ID per run, so nothing later
            // reuses this run's bundle MCP runtime; retire it at settlement.
            ...(prepared.run.kind === "isolated" ? { cleanupBundleMcpOnRunEnd: true } : {}),
            replyConversation: prepareReplyConversation({
              ctx: heartbeatContext,
              sessionEntry: suppressOriginatingContext ? undefined : prepared.conversationEntry,
              isHeartbeat: true,
            }),
            [REPLY_OPERATION_RUN_STATE]: state,
            heartbeatModelOverride: heartbeat?.model?.trim(),
            ...(prepared.usesHeartbeatResponseTool
              ? {
                  enableHeartbeatTool: true,
                  forceHeartbeatTool: true,
                  sourceReplyDeliveryMode: "message_tool_only",
                }
              : {}),
            abortSignal: signal,
            // Admitted task continuations retain their ordinary agent budget even after wake coalescing.
            timeoutOverrideSeconds: prepared.hasTaskContinuation
              ? undefined
              : resolveHeartbeatTimeoutOverrideSeconds(cfg, heartbeat),
            // A conversation's continuation keeps its full context and cached prompt prefix.
            bootstrapContextMode:
              heartbeat?.lightContext === true && !wake.preflight.conversationRoute
                ? "lightweight"
                : undefined,
            continuesConversation: Boolean(wake.preflight.conversationRoute),
            disableBlockStreaming: true,
            suppressToolProgressMessages: true,
            suppressDefaultToolProgressMessages: true,
            onModelSelected: prepared.replyPrefix.onModelSelected,
            onSessionPrepared: (binding) => {
              // Capture initialization's exact identity once; later replacements cannot inherit delivery.
              if (
                !policy.prepared.policySessionEntry &&
                !prepared.outboundPolicySessionKey &&
                binding.sessionKey === prepared.sessionKey &&
                binding.storePath === prepared.storePath &&
                binding.lifecycleRevision !== undefined
              ) {
                policy.prepared = {
                  ...prepared,
                  policySessionEntry: {
                    sessionId: binding.sessionId,
                    lifecycleRevision: binding.lifecycleRevision,
                    updatedAt: startedAt,
                  },
                };
              }
            },
          },
          {
            sessionKey: prepared.inspectsRunQueue ? prepared.sessionKey : runSessionKey,
            heartbeatEventQueueSessionKey: eventQueueKey,
            execRequestOwners,
            events: prepared.inspectsRunQueue ? prepared.genericEvents : [],
            deferredEventIds: [...deferredGenericIds, ...ordinaryGenericIds].filter(
              (id): id is string => typeof id === "string",
            ),
            onEventsAdmitted: (events) => {
              admittedGenericEvents.push(
                ...events.filter((event) => ordinaryGenericIds.has(event.id)),
              );
            },
          },
        ),
        dispatcherOptions: {
          deliver: (payload) =>
            deliverHeartbeatDispatch(
              policy,
              payload,
              execRequestAbortSignal(
                execRequestOwners,
                state.agentTurnOwner?.abortSignal ?? signal,
              ),
            ),
        },
      });
    await (sourceScope && assertSourceCurrent
      ? withSessionTranscriptWriteAssertion(sourceScope, assertSourceCurrent, dispatch)
      : dispatch());
    const settled = settledResult();
    if (settled) {
      return settled;
    }
    const execution = resolveReplyOperationAgentTurn(state);
    const reason =
      execution === "superseded"
        ? "preempted"
        : execution === "cancelled"
          ? "agent-runner-cancelled"
          : "requests-in-flight";
    emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
    return retireRefusedPoll({ status: "skipped", reason });
  } catch (error) {
    const settled = settledResult();
    if (settled) {
      return settled;
    }
    const reason = formatErrorMessage(error);
    emitHeartbeatEvent({
      status: "failed",
      reason,
      durationMs: Date.now() - startedAt,
      channel,
      accountId: delivery.accountId,
      indicatorType: visibility.useIndicator ? resolveIndicatorType("failed") : undefined,
    });
    heartbeatLog.error(`heartbeat failed: ${reason}`, { error: reason });
    return { status: "failed", reason };
  } finally {
    if (
      !execRequestOwners.some((owner) => owner.signal.aborted) ||
      (policy.execDeliveryOutcome !== undefined && policy.execDeliveryOutcome !== "rejected")
    ) {
      consumeSelectedSystemEventEntries(eventQueueKey, admittedGenericEvents);
    }
    releaseSource?.();
    typing?.onCleanup?.();
  }
}
