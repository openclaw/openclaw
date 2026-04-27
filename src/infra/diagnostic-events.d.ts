import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type DiagnosticTraceContext } from "./diagnostic-trace-context.js";
export type DiagnosticSessionState = "idle" | "processing" | "waiting";
type DiagnosticBaseEvent = {
    ts: number;
    seq: number;
    trace?: DiagnosticTraceContext;
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
export type DiagnosticMessageDeliveryKind = "text" | "media" | "edit" | "reaction" | "other";
type DiagnosticMessageDeliveryBaseEvent = DiagnosticBaseEvent & {
    channel: string;
    sessionKey?: string;
    deliveryKind: DiagnosticMessageDeliveryKind;
};
export type DiagnosticMessageDeliveryStartedEvent = DiagnosticMessageDeliveryBaseEvent & {
    type: "message.delivery.started";
};
export type DiagnosticMessageDeliveryCompletedEvent = DiagnosticMessageDeliveryBaseEvent & {
    type: "message.delivery.completed";
    durationMs: number;
    resultCount: number;
};
export type DiagnosticMessageDeliveryErrorEvent = DiagnosticMessageDeliveryBaseEvent & {
    type: "message.delivery.error";
    durationMs: number;
    errorCategory: string;
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
};
export type DiagnosticToolLoopEvent = DiagnosticBaseEvent & {
    type: "tool.loop";
    sessionKey?: string;
    sessionId?: string;
    toolName: string;
    level: "warning" | "critical";
    action: "warn" | "block";
    detector: "generic_repeat" | "unknown_tool_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
    count: number;
    message: string;
    pairedToolName?: string;
};
export type DiagnosticToolParamsSummary = {
    kind: "object";
} | {
    kind: "array";
    length: number;
} | {
    kind: "string";
    length: number;
} | {
    kind: "number" | "boolean" | "null" | "undefined" | "other";
};
type DiagnosticToolExecutionBaseEvent = DiagnosticBaseEvent & {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    toolName: string;
    toolCallId?: string;
    paramsSummary?: DiagnosticToolParamsSummary;
};
export type DiagnosticToolExecutionStartedEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.started";
};
export type DiagnosticToolExecutionCompletedEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.completed";
    durationMs: number;
};
export type DiagnosticToolExecutionErrorEvent = DiagnosticToolExecutionBaseEvent & {
    type: "tool.execution.error";
    durationMs: number;
    errorCategory: string;
    errorCode?: string;
};
export type DiagnosticExecProcessCompletedEvent = DiagnosticBaseEvent & {
    type: "exec.process.completed";
    sessionKey?: string;
    target: "host" | "sandbox";
    mode: "child" | "pty";
    outcome: "completed" | "failed";
    durationMs: number;
    commandLength: number;
    exitCode?: number;
    exitSignal?: string;
    timedOut?: boolean;
    failureKind?: "shell-command-not-found" | "shell-not-executable" | "overall-timeout" | "no-output-timeout" | "signal" | "aborted" | "runtime-error";
};
type DiagnosticRunBaseEvent = DiagnosticBaseEvent & {
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    provider?: string;
    model?: string;
    trigger?: string;
    channel?: string;
};
export type DiagnosticRunStartedEvent = DiagnosticRunBaseEvent & {
    type: "run.started";
};
export type DiagnosticRunCompletedEvent = DiagnosticRunBaseEvent & {
    type: "run.completed";
    durationMs: number;
    outcome: "completed" | "aborted" | "error";
    errorCategory?: string;
};
type DiagnosticModelCallBaseEvent = DiagnosticBaseEvent & {
    type: "model.call.started" | "model.call.completed" | "model.call.error";
    runId: string;
    callId: string;
    sessionKey?: string;
    sessionId?: string;
    provider: string;
    model: string;
    api?: string;
    transport?: string;
    upstreamRequestIdHash?: string;
};
export type DiagnosticModelCallStartedEvent = DiagnosticModelCallBaseEvent & {
    type: "model.call.started";
};
export type DiagnosticModelCallCompletedEvent = DiagnosticModelCallBaseEvent & {
    type: "model.call.completed";
    durationMs: number;
};
export type DiagnosticModelCallErrorEvent = DiagnosticModelCallBaseEvent & {
    type: "model.call.error";
    durationMs: number;
    errorCategory: string;
};
export type DiagnosticContextAssembledEvent = DiagnosticBaseEvent & {
    type: "context.assembled";
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    provider: string;
    model: string;
    channel?: string;
    trigger?: string;
    messageCount: number;
    historyTextChars: number;
    historyImageBlocks: number;
    maxMessageTextChars: number;
    systemPromptChars: number;
    promptChars: number;
    promptImages: number;
    contextTokenBudget?: number;
    reserveTokens?: number;
};
export type DiagnosticMemoryUsage = {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
};
export type DiagnosticMemorySampleEvent = DiagnosticBaseEvent & {
    type: "diagnostic.memory.sample";
    memory: DiagnosticMemoryUsage;
    uptimeMs?: number;
};
export type DiagnosticMemoryPressureEvent = DiagnosticBaseEvent & {
    type: "diagnostic.memory.pressure";
    level: "warning" | "critical";
    reason: "rss_threshold" | "heap_threshold" | "rss_growth";
    memory: DiagnosticMemoryUsage;
    thresholdBytes?: number;
    rssGrowthBytes?: number;
    windowMs?: number;
};
export type DiagnosticPayloadLargeEvent = DiagnosticBaseEvent & {
    type: "payload.large";
    surface: string;
    action: "rejected" | "truncated" | "chunked";
    bytes?: number;
    limitBytes?: number;
    count?: number;
    channel?: string;
    pluginId?: string;
    reason?: string;
};
export type DiagnosticLogRecordEvent = DiagnosticBaseEvent & {
    type: "log.record";
    level: string;
    message: string;
    loggerName?: string;
    loggerParents?: string[];
    attributes?: Record<string, string | number | boolean>;
    code?: {
        line?: number;
        functionName?: string;
    };
};
export type DiagnosticEventPayload = DiagnosticUsageEvent | DiagnosticWebhookReceivedEvent | DiagnosticWebhookProcessedEvent | DiagnosticWebhookErrorEvent | DiagnosticMessageQueuedEvent | DiagnosticMessageProcessedEvent | DiagnosticMessageDeliveryStartedEvent | DiagnosticMessageDeliveryCompletedEvent | DiagnosticMessageDeliveryErrorEvent | DiagnosticSessionStateEvent | DiagnosticSessionStuckEvent | DiagnosticLaneEnqueueEvent | DiagnosticLaneDequeueEvent | DiagnosticRunAttemptEvent | DiagnosticHeartbeatEvent | DiagnosticToolLoopEvent | DiagnosticToolExecutionStartedEvent | DiagnosticToolExecutionCompletedEvent | DiagnosticToolExecutionErrorEvent | DiagnosticExecProcessCompletedEvent | DiagnosticRunStartedEvent | DiagnosticRunCompletedEvent | DiagnosticModelCallStartedEvent | DiagnosticModelCallCompletedEvent | DiagnosticModelCallErrorEvent | DiagnosticContextAssembledEvent | DiagnosticMemorySampleEvent | DiagnosticMemoryPressureEvent | DiagnosticPayloadLargeEvent | DiagnosticLogRecordEvent;
export type DiagnosticEventInput = DiagnosticEventPayload extends infer Event ? Event extends DiagnosticEventPayload ? Omit<Event, "seq" | "ts"> : never : never;
export type DiagnosticEventMetadata = Readonly<{
    trusted: boolean;
}>;
type DiagnosticEventListener = (evt: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void;
export declare function isDiagnosticsEnabled(config?: OpenClawConfig): boolean;
export declare function setDiagnosticsEnabledForProcess(enabled: boolean): void;
export declare function areDiagnosticsEnabledForProcess(): boolean;
export declare function emitDiagnosticEvent(event: DiagnosticEventInput): void;
export declare function emitTrustedDiagnosticEvent(event: DiagnosticEventInput): void;
export declare function onInternalDiagnosticEvent(listener: DiagnosticEventListener): () => void;
export declare function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void;
export declare function formatDiagnosticTraceparentForPropagation(event: {
    trace?: DiagnosticTraceContext;
}, metadata: DiagnosticEventMetadata): string | undefined;
export declare function resetDiagnosticEventsForTest(): void;
export {};
