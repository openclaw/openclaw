import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS,
  isHeartbeatContentEffectivelyEmpty,
} from "../auto-reply/heartbeat.js";
import { isStoredConversationRoute } from "../auto-reply/reply/prompt-session-context.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readCronScratchSnapshot } from "../cron/scratch-read.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { channelRouteTargetsMatchExact } from "../plugin-sdk/channel-route.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "../sessions/session-state-event-kinds.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { formatErrorMessage } from "./errors.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isConversationExecCompletion,
  isExecCompletionEvent,
  isHeartbeatDeliveryAwarenessEvent,
  isRelayableExecCompletionEvent,
} from "./heartbeat-events-filter.js";
import { heartbeatLog as log } from "./heartbeat-log.js";
import {
  resolveConfiguredHeartbeatPrompt,
  resolveHeartbeatResponseToolPrompt,
} from "./heartbeat-runner-config.js";
import {
  type HeartbeatSessionSelection,
  resolveHeartbeatSession,
  resolveHeartbeatSessionSelection,
} from "./heartbeat-runner-session.js";
import {
  resolveHeartbeatWakePayloadFlags,
  type HeartbeatWakePayloadFlags,
} from "./heartbeat-wake-policy.js";
import {
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  type HeartbeatScheduledTask,
  type HeartbeatWakeSource,
} from "./heartbeat-wake.js";
import { resolveSystemEventQueueKey } from "./system-event-ownership.js";
import {
  peekSystemEventEntries,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "./system-events.js";

export function truncateHeartbeatPreview(value: string | undefined): string | undefined {
  return value ? truncateUtf16Safe(value, 200) : undefined;
}

type HeartbeatSkipReason = "empty-heartbeat-file" | typeof HEARTBEAT_SKIP_NO_PENDING_EVENT;

type HeartbeatPreflight = HeartbeatWakePayloadFlags & {
  session: HeartbeatSessionSelection;
  /** Selection under the heartbeat's own isolation; differs from `session` only on a continuation. */
  heartbeatSession: HeartbeatSessionSelection;
  pendingEventEntries: ReturnType<typeof peekSystemEventEntries>;
  turnSourceDeliveryContext: ReturnType<typeof resolveSystemEventDeliveryContext>;
  /** Route of a conversation's own command completion; that conversation owns the turn. */
  conversationRoute?: DeliveryContext;
  shouldInspectPendingEvents: boolean;
  authoritativeScheduledTick: boolean;
  skipReason?: HeartbeatSkipReason;
  scratchJobId?: string;
  scratchRevision?: number;
  heartbeatScratchContent?: string;
};

/**
 * A targeted exec wake whose pending events are all command completions started by a
 * conversation turn, captured in the session's own conversation, continues that
 * conversation, not the periodic monitor. Commands started by heartbeat or automation
 * work keep heartbeat isolation and delivery.
 */
function resolveConversationCompletionRoute(
  events: readonly SystemEvent[],
  entry: SessionEntry | undefined,
): DeliveryContext | undefined {
  const route = events[0]?.deliveryContext;
  return route &&
    events.every(
      (event) =>
        isConversationExecCompletion(event) &&
        channelRouteTargetsMatchExact({ left: event.deliveryContext, right: route }),
    ) &&
    isStoredConversationRoute({ ...route, entry })
    ? route
    : undefined;
}

/**
 * Terminal no-op preflight (empty scratch, consumed exec events) must resolve
 * before retryable busy guards; wakes carrying heartbeat tasks keep deferral.
 */
export function shouldPreflightWakeBeforeBusy(
  source: HeartbeatWakeSource | undefined,
  scheduledEveryMs: number | undefined,
  scheduledTaskCount: number,
): boolean {
  return (
    scheduledTaskCount === 0 &&
    (source === "interval" ||
      (source === "exec-event" &&
        !(
          typeof scheduledEveryMs === "number" &&
          Number.isSafeInteger(scheduledEveryMs) &&
          scheduledEveryMs > 0
        )))
  );
}

export async function resolveHeartbeatPreflight(params: {
  cfg: OpenClawConfig;
  agentId: string;
  heartbeat?: HeartbeatConfig;
  sessionKey?: string;
  reason?: string;
  source?: HeartbeatWakeSource;
  scheduledEveryMs?: number;
  scheduledTasks?: readonly HeartbeatScheduledTask[];
}): Promise<HeartbeatPreflight> {
  let monitorScratch: Awaited<ReturnType<typeof readCronScratchSnapshot>>;
  try {
    monitorScratch = await readCronScratchSnapshot(resolveCronJobsStorePathFromConfig(params.cfg), {
      kind: "heartbeat",
      agentId: params.agentId,
    });
  } catch (error) {
    log.warn(`heartbeat: scratch read failed: ${formatErrorMessage(error)}`);
  }
  const wakeFlags = resolveHeartbeatWakePayloadFlags(params);
  const queue = resolveHeartbeatSession(
    params.cfg,
    params.agentId,
    params.heartbeat,
    params.sessionKey,
  );
  const pendingEventEntries = peekSystemEventEntries(
    resolveSystemEventQueueKey(queue.sessionKey, params.agentId),
  ).filter((event) => !isHeartbeatDeliveryAwarenessEvent(event));
  const turnSourceDeliveryContext = resolveSystemEventDeliveryContext(pendingEventEntries);
  const authoritativeScheduledTick =
    typeof params.scheduledEveryMs === "number" &&
    Number.isSafeInteger(params.scheduledEveryMs) &&
    params.scheduledEveryMs > 0;
  const conversationRoute =
    wakeFlags.isExecEventWake && !authoritativeScheduledTick && !params.scheduledTasks?.length
      ? resolveConversationCompletionRoute(pendingEventEntries, queue.entry)
      : undefined;
  const heartbeatSession = resolveHeartbeatSessionSelection(
    params.cfg,
    params.agentId,
    params.heartbeat,
    queue,
    params.heartbeat?.isolatedSession === true,
  );
  // Isolation saves periodic-poll history cost; a conversation's continuation needs its history.
  const session = conversationRoute
    ? resolveHeartbeatSessionSelection(params.cfg, params.agentId, params.heartbeat, queue, false)
    : heartbeatSession;
  const hasTaggedCronEvents = pendingEventEntries.some((event) =>
    event.contextKey?.startsWith("cron:"),
  );
  // The selected queue follows isolated execution into reply admission; the base queue does not.
  const shouldInspectWakePendingEvents = wakeFlags.isWakePayload && session.inspectsRunQueue;
  const shouldInspectPendingEvents =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    shouldInspectWakePendingEvents ||
    hasTaggedCronEvents;
  const shouldBypassScratchGates =
    wakeFlags.isExecEventWake ||
    wakeFlags.isCronWake ||
    wakeFlags.isWakePayload ||
    hasTaggedCronEvents;
  const heartbeatScratchContent = monitorScratch?.state.scratch?.content;
  const basePreflight = {
    ...wakeFlags,
    session,
    heartbeatSession,
    pendingEventEntries,
    turnSourceDeliveryContext,
    ...(conversationRoute ? { conversationRoute } : {}),
    shouldInspectPendingEvents,
    authoritativeScheduledTick,
    ...(monitorScratch?.jobId
      ? {
          scratchJobId: monitorScratch.jobId,
          scratchRevision: monitorScratch.state.currentRevision,
        }
      : {}),
    // Bypass scopes (cron/exec events and wake payloads) stay
    // self-contained: only the job identity travels so heartbeat_respond can
    // still persist scratch, never the monitor instructions themselves.
    ...(!shouldBypassScratchGates && heartbeatScratchContent !== undefined
      ? { heartbeatScratchContent }
      : {}),
  } satisfies Omit<HeartbeatPreflight, "skipReason">;

  // The exec completion can be acknowledged by process poll after its wake is
  // queued. Treat that stale wake as consumed without touching unrelated events.
  if (
    wakeFlags.isExecEventWake &&
    !basePreflight.authoritativeScheduledTick &&
    !params.scheduledTasks?.length &&
    !hasTaggedCronEvents &&
    !pendingEventEntries.some((event) => isExecCompletionEvent(event.text))
  ) {
    return {
      ...basePreflight,
      skipReason: HEARTBEAT_SKIP_NO_PENDING_EVENT,
    };
  }
  // Payload/task wakes bypass the empty-scratch gate; absent scratch uses the generic prompt.
  if (
    shouldBypassScratchGates ||
    params.scheduledTasks?.length ||
    heartbeatScratchContent === undefined
  ) {
    return basePreflight;
  }
  if (isHeartbeatContentEffectivelyEmpty(heartbeatScratchContent)) {
    return {
      ...basePreflight,
      skipReason: "empty-heartbeat-file",
    };
  }
  return basePreflight;
}

type HeartbeatPromptResolution = {
  prompt: string;
  hasTaskContinuation: boolean;
  hasExecCompletion: boolean;
  hasRelayableExecCompletion: boolean;
  hasCronEvents: boolean;
  usesHeartbeatResponseTool: boolean;
  genericEvents: SystemEvent[];
  inspectedSystemEventsToConsume: SystemEvent[];
};

function appendHeartbeatScratch(prompt: string, heartbeatScratchContent?: string): string {
  if (!heartbeatScratchContent) {
    return prompt;
  }
  const directives = heartbeatScratchContent.trim();
  if (!directives || prompt.includes(directives)) {
    return prompt;
  }
  return `${prompt}\n\nHeartbeat monitor scratch:\n${directives}`;
}

export function resolveHeartbeatRunPrompt(params: {
  cfg: OpenClawConfig;
  heartbeat?: HeartbeatConfig;
  preflight: HeartbeatPreflight;
  canRelayToUser: boolean;
  scheduledTasks: readonly HeartbeatScheduledTask[];
  useHeartbeatResponseTool: boolean;
}): HeartbeatPromptResolution {
  const pendingEventEntries = params.preflight.pendingEventEntries;
  const genericEvents: SystemEvent[] = [];
  const cronEvents: SystemEvent[] = [];
  const execEvents: SystemEvent[] = [];
  const cronNoise: SystemEvent[] = [];
  // Select once: admission owns generic text; completed delivery owns dedicated
  // prompts and filtered cron noise. Late arrivals retain their queue identities.
  for (const event of pendingEventEntries) {
    if (event.contextKey?.startsWith(SESSION_CREATED_NOTICE_CONTEXT_PREFIX)) {
      genericEvents.push(event);
    } else if (isExecCompletionEvent(event.text)) {
      if (params.preflight.shouldInspectPendingEvents) {
        execEvents.push(event);
      }
    } else if (params.preflight.isCronWake || event.contextKey?.startsWith("cron:")) {
      (isCronSystemEvent(event.text) ? cronEvents : cronNoise).push(event);
    } else {
      genericEvents.push(event);
    }
  }
  const hasExecCompletion = execEvents.length > 0;
  const hasRelayableExecCompletion =
    params.canRelayToUser && execEvents.some((event) => isRelayableExecCompletionEvent(event.text));
  const hasCronEvents = cronEvents.length > 0;
  const hasBackgroundTaskEvent =
    params.preflight.session.inspectsRunQueue &&
    genericEvents.some((event) => event.contextKey?.startsWith("task:"));
  if (params.scheduledTasks.length > 0) {
    const taskList = params.scheduledTasks
      .map((task) => `- ${task.name}: ${task.prompt}`)
      .join("\n");
    const completionInstruction = params.useHeartbeatResponseTool
      ? `After completing all due tasks:\n${HEARTBEAT_RESPONSE_TOOL_INSTRUCTIONS}`
      : `After completing all due tasks, reply ${SILENT_REPLY_TOKEN}.`;
    const taskPrompt = `Run the following periodic tasks (only those due based on their intervals):

${taskList}

${completionInstruction}`;
    return {
      prompt: appendHeartbeatScratch(taskPrompt, params.preflight.heartbeatScratchContent),
      hasTaskContinuation: hasBackgroundTaskEvent,
      hasExecCompletion: false,
      hasRelayableExecCompletion: false,
      hasCronEvents: false,
      usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
      genericEvents,
      inspectedSystemEventsToConsume: cronNoise,
    };
  }

  const basePrompt =
    hasExecCompletion || hasCronEvents
      ? (hasExecCompletion ? buildExecEventPrompt : buildCronEventPrompt)(
          (hasExecCompletion ? execEvents : cronEvents).map((event) => event.text),
          {
            deliverToUser: params.canRelayToUser,
            useHeartbeatResponseTool: params.useHeartbeatResponseTool,
          },
        )
      : params.useHeartbeatResponseTool
        ? resolveHeartbeatResponseToolPrompt(params.cfg, params.heartbeat)
        : resolveConfiguredHeartbeatPrompt(params.cfg, params.heartbeat);
  return {
    prompt: appendHeartbeatScratch(basePrompt, params.preflight.heartbeatScratchContent),
    hasTaskContinuation:
      hasExecCompletion ||
      hasBackgroundTaskEvent ||
      cronEvents.some((event) => event.contextKey?.startsWith("task:")),
    hasExecCompletion,
    hasRelayableExecCompletion,
    hasCronEvents,
    usesHeartbeatResponseTool: params.useHeartbeatResponseTool,
    genericEvents,
    inspectedSystemEventsToConsume: [
      ...cronNoise,
      ...(hasExecCompletion ? execEvents : cronEvents),
    ],
  };
}
