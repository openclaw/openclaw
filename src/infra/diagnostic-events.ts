import type { OpenClawConfig } from "../config/config.js";

export type DiagnosticSessionState = "idle" | "processing" | "waiting";

type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
};

export type DiagnosticUsageEvent = DiagnosticBaseEvent & {
  type: "model.usage";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  lastCallUsage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};

export type DiagnosticWebhookReceivedEvent = DiagnosticBaseEvent & {
  type: "webhook.received";
  channel: string;
  updateType?: string;
  chatId?: number | string;
};

export type DiagnosticWebhookProcessedEvent = DiagnosticBaseEvent & {
  type: "webhook.processed";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
};

export type DiagnosticWebhookErrorEvent = DiagnosticBaseEvent & {
  type: "webhook.error";
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
};

export type DiagnosticMessageQueuedEvent = DiagnosticBaseEvent & {
  type: "message.queued";
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  source: string;
  queueDepth?: number;
};

export type DiagnosticMessageProcessedEvent = DiagnosticBaseEvent & {
  type: "message.processed";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
};

export type DiagnosticMessageFirstVisibleEvent = DiagnosticBaseEvent & {
  type: "message.first_visible";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  kind: "tool" | "block" | "status" | "final";
  dispatchToFirstVisibleMs: number;
};

export type DiagnosticMessageFirstVisibleTimeoutEvent = DiagnosticBaseEvent & {
  type: "message.first_visible_timeout";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  thresholdMs: number;
};

export type DiagnosticTurnLatencyStageEvent = DiagnosticBaseEvent & {
  type: "turn.latency.stage";
  turnLatencyId: string;
  stage:
    | "dispatch_started"
    | "queue_arbitrated"
    | "first_visible_scheduled"
    | "run_started"
    | "run_first_output"
    | "first_visible_emitted"
    | "final_dispatched"
    | "completed"
    | "context_skills_env_completed"
    | "context_bootstrap_completed"
    | "context_tools_completed"
    | "context_bundle_mcp_completed"
    | "context_bundle_lsp_completed"
    | "context_system_prompt_completed"
    | "context_system_prompt_report_completed"
    | "context_assembly_completed"
    | "context_engine_assemble_completed"
    | "model_first_token"
    | "model_completion_completed"
    | "context_engine_finalize_completed"
    | "outbound_reply_enqueued"
    | "acp_ensure_session_started"
    | "acp_ensure_session_completed"
    | "acp_run_started"
    | "acp_first_event"
    | "acp_first_visible_output"
    | "acp_error_visible"
    | "acp_reset_tail_started"
    | "acp_reset_tail_completed"
    | "fallback_started";
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionKey?: string;
  sessionId?: string;
  originatingChannel?: string;
  routed?: boolean;
  replyGeneration?: number;
  durationMs?: number;
  queueModeConfigured?: string;
  queueModeFinal?: string;
  supervisorAction?: string;
  supervisorRelation?: string;
  firstVisibleKind?: "tool" | "block" | "status" | "final";
  provider?: string;
  model?: string;
  backend?: string;
};

export type DiagnosticEarlyStatusPolicyEvent = DiagnosticBaseEvent & {
  type: "early_status.policy";
  channel: string;
  sessionKey?: string;
  sessionId?: string;
  queueMode: string;
  decisionShouldEmit: boolean;
  activationShouldEmit: boolean;
  decisionReason: string;
  activationReason: string;
  recommendationLevel: "prioritize" | "observe" | "deprioritize";
  recommendationReason: string;
};

export type DiagnosticSessionStateEvent = DiagnosticBaseEvent & {
  type: "session.state";
  sessionKey?: string;
  sessionId?: string;
  prevState?: DiagnosticSessionState;
  state: DiagnosticSessionState;
  reason?: string;
  queueDepth?: number;
};

export type DiagnosticSessionStuckEvent = DiagnosticBaseEvent & {
  type: "session.stuck";
  sessionKey?: string;
  sessionId?: string;
  state: DiagnosticSessionState;
  ageMs: number;
  queueDepth?: number;
};

export type DiagnosticLaneEnqueueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.enqueue";
  lane: string;
  queueSize: number;
};

export type DiagnosticLaneDequeueEvent = DiagnosticBaseEvent & {
  type: "queue.lane.dequeue";
  lane: string;
  queueSize: number;
  waitMs: number;
};

export type DiagnosticRunAttemptEvent = DiagnosticBaseEvent & {
  type: "run.attempt";
  sessionKey?: string;
  sessionId?: string;
  runId: string;
  attempt: number;
};

export type DiagnosticHeartbeatEvent = DiagnosticBaseEvent & {
  type: "diagnostic.heartbeat";
  webhooks: {
    received: number;
    processed: number;
    errors: number;
  };
  active: number;
  waiting: number;
  queued: number;
  firstVisible?: {
    sampleCount: number;
    avgMs: number;
    p95Ms: number;
    maxMs: number;
    timeoutCount: number;
  };
  latency?: {
    sampleCount: number;
    dominant?: Array<{
      segment:
        | "dispatchToQueue"
        | "queueToRun"
        | "acpEnsureToRun"
        | "runToFirstEvent"
        | "firstEventToFirstVisible"
        | "runToFirstVisible"
        | "firstVisibleToFinal"
        | "endToEnd";
      count: number;
    }>;
    segments: Partial<
      Record<
        | "dispatchToQueue"
        | "queueToRun"
        | "acpEnsureToRun"
        | "runToFirstEvent"
        | "firstEventToFirstVisible"
        | "runToFirstVisible"
        | "firstVisibleToFinal"
        | "endToEnd",
        {
          avgMs: number;
          p95Ms: number;
          maxMs: number;
        }
      >
    >;
  };
  earlyStatus?: {
    sampleCount: number;
    eligibleCount: number;
    semanticGateCount: number;
    latencyGateCount: number;
    topReasons?: Array<{
      reason: string;
      count: number;
    }>;
    phase2Supplements?: {
      sampleCount: number;
      eligibleCount: number;
      hitRatePct: number;
      topSkipReasons?: Array<{
        reason: string;
        count: number;
      }>;
      statusFirstVisibleAvgMs?: number;
      statusFirstVisibleP95Ms?: number;
    };
  };
};

export type DiagnosticToolLoopEvent = DiagnosticBaseEvent & {
  type: "tool.loop";
  sessionKey?: string;
  sessionId?: string;
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: "generic_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
};

export type DiagnosticEventPayload =
  | DiagnosticUsageEvent
  | DiagnosticWebhookReceivedEvent
  | DiagnosticWebhookProcessedEvent
  | DiagnosticWebhookErrorEvent
  | DiagnosticMessageQueuedEvent
  | DiagnosticMessageFirstVisibleEvent
  | DiagnosticMessageFirstVisibleTimeoutEvent
  | DiagnosticTurnLatencyStageEvent
  | DiagnosticMessageProcessedEvent
  | DiagnosticEarlyStatusPolicyEvent
  | DiagnosticSessionStateEvent
  | DiagnosticSessionStuckEvent
  | DiagnosticLaneEnqueueEvent
  | DiagnosticLaneDequeueEvent
  | DiagnosticRunAttemptEvent
  | DiagnosticHeartbeatEvent
  | DiagnosticToolLoopEvent;

export type DiagnosticEventInput = DiagnosticEventPayload extends infer Event
  ? Event extends DiagnosticEventPayload
    ? Omit<Event, "seq" | "ts">
    : never
  : never;

type DiagnosticEventsGlobalState = {
  seq: number;
  listeners: Set<(evt: DiagnosticEventPayload) => void>;
  dispatchDepth: number;
};

function getDiagnosticEventsState(): DiagnosticEventsGlobalState {
  const globalStore = globalThis as typeof globalThis & {
    __openclawDiagnosticEventsState?: DiagnosticEventsGlobalState;
  };
  if (!globalStore.__openclawDiagnosticEventsState) {
    globalStore.__openclawDiagnosticEventsState = {
      seq: 0,
      listeners: new Set<(evt: DiagnosticEventPayload) => void>(),
      dispatchDepth: 0,
    };
  }
  return globalStore.__openclawDiagnosticEventsState;
}

export function isDiagnosticsEnabled(config?: OpenClawConfig): boolean {
  return config?.diagnostics?.enabled === true;
}

export function emitDiagnosticEvent(event: DiagnosticEventInput) {
  const state = getDiagnosticEventsState();
  if (state.dispatchDepth > 100) {
    console.error(
      `[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${event.type}`,
    );
    return;
  }

  const enriched = {
    ...event,
    seq: (state.seq += 1),
    ts: Date.now(),
  } satisfies DiagnosticEventPayload;
  state.dispatchDepth += 1;
  for (const listener of state.listeners) {
    try {
      listener(enriched);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? (err.stack ?? err.message)
          : typeof err === "string"
            ? err
            : String(err);
      console.error(
        `[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`,
      );
      // Ignore listener failures.
    }
  }
  state.dispatchDepth -= 1;
}

export function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void {
  const state = getDiagnosticEventsState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function resetDiagnosticEventsForTest(): void {
  const state = getDiagnosticEventsState();
  state.seq = 0;
  state.listeners.clear();
  state.dispatchDepth = 0;
}
