import type { OpenClawConfig } from "../config/config.js";

export type DiagnosticSessionState = "idle" | "processing" | "waiting";

type DiagnosticBaseEvent = {
  ts: number;
  seq: number;
};

// -- GenAI message content types (OTel GenAI semantic conventions v1.38+) --

export type GenAiPartText = { type: "text"; content: string };
export type GenAiPartToolCall = {
  type: "tool_call";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
};
export type GenAiPartToolCallResponse = {
  type: "tool_call_response";
  id: string;
  response: unknown;
};
export type GenAiPartReasoning = { type: "reasoning"; content: string };
export type GenAiPartMedia = {
  type: "uri" | "blob";
  modality: "image" | "audio" | "video";
  mime_type?: string;
  uri?: string;
  content?: string;
};

export type GenAiPart =
  | GenAiPartText
  | GenAiPartToolCall
  | GenAiPartToolCallResponse
  | GenAiPartReasoning
  | GenAiPartMedia;

export type GenAiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  parts: GenAiPart[];
  finish_reason?: string;
};

export type GenAiToolDef = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type DiagnosticInferenceEvent = DiagnosticBaseEvent & {
  type: "model.inference";
  runId?: string;
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
  // GenAI semantic convention fields (v1.38+)
  operationName?: string;
  responseId?: string;
  responseModel?: string;
  finishReasons?: string[];
  outputMessages?: GenAiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  ttftMs?: number;
  error?: string;
  errorType?: string;
  callIndex?: number;
};

export type DiagnosticInferenceStartedEvent = DiagnosticBaseEvent & {
  type: "model.inference.started";
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  // GenAI semantic convention fields (v1.38+)
  operationName?: string;
  inputMessages?: GenAiMessage[];
  systemInstructions?: GenAiPart[];
  toolDefinitions?: GenAiToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  callIndex?: number;
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

export type DiagnosticRunStartedEvent = DiagnosticBaseEvent & {
  type: "run.started";
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
};

export type DiagnosticRunCompletedEvent = DiagnosticBaseEvent & {
  type: "run.completed";
  runId: string;
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
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
  // GenAI semantic convention fields (v1.38+)
  operationName?: string;
  responseId?: string;
  responseModel?: string;
  finishReasons?: string[];
  inputMessages?: GenAiMessage[];
  outputMessages?: GenAiMessage[];
  systemInstructions?: GenAiPart[];
  toolDefinitions?: GenAiToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  error?: string;
  errorType?: string;
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

export type DiagnosticToolExecutionEvent = DiagnosticBaseEvent & {
  type: "tool.execution";
  runId?: string;
  toolName: string;
  toolType?: "function" | "extension" | "datastore";
  toolCallId?: string;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  durationMs?: number;
  error?: string;
  /** Tool call arguments (input). */
  toolInput?: Record<string, unknown>;
  /** Tool call result (output). */
  toolOutput?: unknown;
};

export type DiagnosticModelUsageEvent = DiagnosticBaseEvent & {
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

export type DiagnosticEventPayload =
  | DiagnosticInferenceEvent
  | DiagnosticInferenceStartedEvent
  | DiagnosticWebhookReceivedEvent
  | DiagnosticWebhookProcessedEvent
  | DiagnosticWebhookErrorEvent
  | DiagnosticMessageQueuedEvent
  | DiagnosticMessageProcessedEvent
  | DiagnosticSessionStateEvent
  | DiagnosticSessionStuckEvent
  | DiagnosticLaneEnqueueEvent
  | DiagnosticLaneDequeueEvent
  | DiagnosticRunAttemptEvent
  | DiagnosticRunStartedEvent
  | DiagnosticRunCompletedEvent
  | DiagnosticHeartbeatEvent
  | DiagnosticToolLoopEvent
  | DiagnosticToolExecutionEvent
  | DiagnosticModelUsageEvent;

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

const GLOBAL_STATE_KEY = Symbol.for("openclaw.diagnostic-events");

function getDiagnosticEventsState(): DiagnosticEventsGlobalState {
  const globalStore = globalThis as {
    [GLOBAL_STATE_KEY]?: DiagnosticEventsGlobalState;
  };
  if (!globalStore[GLOBAL_STATE_KEY]) {
    globalStore[GLOBAL_STATE_KEY] = {
      seq: 0,
      listeners: new Set<(evt: DiagnosticEventPayload) => void>(),
      dispatchDepth: 0,
    };
  }
  return globalStore[GLOBAL_STATE_KEY];
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
