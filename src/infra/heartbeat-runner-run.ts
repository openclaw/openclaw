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
import { deliveryContextKey } from "../utils/delivery-context.shared.js";
import { formatErrorMessage } from "./errors.js";
import { resolveHeartbeatTimeoutOverrideSeconds } from "./heartbeat-config.js";
import { createHeartbeatDispatch, deliverHeartbeatDispatch } from "./heartbeat-dispatch.js";
import { isExecCompletionEvent } from "./heartbeat-events-filter.js";
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
import {
  resolveHeartbeatRunPrompt,
  shouldSkipConsumedExecWake,
} from "./heartbeat-runner-prompt.js";
import { createHeartbeatTypingCallbacks } from "./heartbeat-typing.js";
import {
  getHeartbeatWakeAbortSignal,
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  HEARTBEAT_SKIP_PREEMPTED,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import { markSessionEventWakeWorkStarted } from "./session-event-wake.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  peekSelectedSystemEventEntries,
  resolveSystemEventDeliveryContext,
} from "./system-events.js";

export async function runHeartbeatOnce(opts: HeartbeatRunOptions): Promise<HeartbeatRunResult> {
  const wake = await resolveHeartbeatWakeStage(opts);
  if (wake.kind === "skipped") {
    return { status: "skipped", reason: wake.reason };
  }
  // Preparation can admit isolated work; later busy skips must retain the occurrence.
  markSessionEventWakeWorkStarted();
  const preparation = await prepareHeartbeatRunStage(wake);
  if (preparation.kind === "skipped") {
    return { status: "skipped", reason: preparation.reason };
  }
  let prepared = preparation;
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
  const policy = createHeartbeatDispatch(opts, wake, prepared);
  const state: ReplyOperationRunState = { heartbeat: policy };
  const signal = getHeartbeatWakeAbortSignal();
  const channel = delivery.channel !== "none" ? delivery.channel : undefined;
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
    const { dispatchInboundMessageWithRoutedChannelDispatcher } =
      await import("../auto-reply/dispatch.js");
    await typing?.onReplyStart();
    // Preparation can yield while process polling acknowledges a completion.
    // Recheck original occurrences; a same-text successor belongs to a later wake.
    const currentPreflight = {
      ...wake.preflight,
      pendingEventEntries: peekSelectedSystemEventEntries(
        resolveSystemEventQueueKey(wake.preflight.session.sessionKey, agentId),
        wake.preflight.pendingEventEntries,
      ),
    };
    if (shouldSkipConsumedExecWake(currentPreflight, wake.scheduledTasks)) {
      emitHeartbeatEvent({
        status: "skipped",
        reason: HEARTBEAT_SKIP_NO_PENDING_EVENT,
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT };
    }
    const target = heartbeat?.target;
    if (
      prepared.inspectsRunQueue &&
      (target === undefined || target === "owner" || target === "last") &&
      deliveryContextKey(
        resolveSystemEventDeliveryContext(currentPreflight.pendingEventEntries),
      ) !== deliveryContextKey(wake.preflight.turnSourceDeliveryContext)
    ) {
      // A consumed occurrence owned this route. Let the wake owner retry with
      // fresh routing instead of sending surviving work to its old destination.
      emitHeartbeatEvent({
        status: "skipped",
        reason: HEARTBEAT_SKIP_PREEMPTED,
        durationMs: Date.now() - startedAt,
      });
      return { status: "skipped", reason: HEARTBEAT_SKIP_PREEMPTED };
    }
    const internalProjection = currentPreflight.pendingEventEntries.some((event) =>
      isExecCompletionEvent(event.text),
    )
      ? prepared.internalProjection
      : undefined;
    prepared = {
      ...prepared,
      internalProjection,
      ...resolveHeartbeatRunPrompt({
        cfg,
        heartbeat,
        preflight: currentPreflight,
        canRelayToUser:
          visibility.showAlerts &&
          ((delivery.channel !== "none" && Boolean(delivery.to)) ||
            internalProjection !== undefined),
        startedAt,
        scheduledTasks: wake.scheduledTasks,
        heartbeatScratchContent: wake.preflight.heartbeatScratchContent,
        useHeartbeatResponseTool: prepared.useHeartbeatResponseTool,
      }),
    };
    // Successful outcome handling must consume the same selection sent to the agent.
    policy.prepared = prepared;
    const heartbeatContext = {
      Body: appendCronStyleCurrentTimeLine(prepared.prompt, cfg, startedAt),
      From: sender,
      To: sender,
      OriginatingChannel: !suppressOriginatingContext ? channel : undefined,
      OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
      AccountId: delivery.accountId,
      ChatType: delivery.chatType,
      MessageThreadId: delivery.threadId,
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
    await dispatchInboundMessageWithRoutedChannelDispatcher({
      cfg,
      ctx: heartbeatContext,
      replyResolver: opts.deps?.getReplyFromConfig,
      suppressOutboundHooks: true,
      replyOptions: withReplySystemEventContext<InternalGetReplyOptions>(
        {
          isHeartbeat: true,
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
          bootstrapContextMode: heartbeat?.lightContext === true ? "lightweight" : undefined,
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
          events: prepared.inspectsRunQueue ? prepared.genericEvents : [],
        },
      ),
      dispatcherOptions: {
        deliver: (payload) =>
          deliverHeartbeatDispatch(policy, payload, state.agentTurnOwner?.abortSignal ?? signal),
      },
    });
    if (policy.result) {
      return policy.result;
    }
    const execution = resolveReplyOperationAgentTurn(state);
    const reason =
      execution === "superseded"
        ? "preempted"
        : execution === "cancelled"
          ? "agent-runner-cancelled"
          : "requests-in-flight";
    emitHeartbeatEvent({ status: "skipped", reason, durationMs: Date.now() - startedAt });
    return { status: "skipped", reason };
  } catch (error) {
    if (policy.result) {
      return policy.result;
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
    typing?.onCleanup?.();
  }
}
