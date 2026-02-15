import crypto from "node:crypto";

export type TraceContext = {
  traceId: string; // 32 hex chars (W3C trace-id)
  spanId: string; // 16 hex chars (W3C parent-id)
  parentSpanId?: string; // 16 hex chars, undefined for root spans
};

export function createTraceId(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function createSpanId(): string {
  return crypto.randomBytes(8).toString("hex");
}

export function createRootTrace(): TraceContext {
  return {
    traceId: createTraceId(),
    spanId: createSpanId(),
  };
}

export function createChildSpan(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: createSpanId(),
    parentSpanId: parent.spanId,
  };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-01`;
}

const traceByRunId = new Map<string, TraceContext>();

export function setTraceContextForRun(runId: string, ctx: TraceContext): void {
  traceByRunId.set(runId, ctx);
}

export function getTraceContextForRun(runId: string): TraceContext | undefined {
  return traceByRunId.get(runId);
}

export function clearTraceContextForRun(runId: string): void {
  traceByRunId.delete(runId);
}

export function resetTraceContextForTests(): void {
  traceByRunId.clear();
}
