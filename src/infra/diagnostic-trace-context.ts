import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { DiagnosticTraceContext } from "./diagnostic-events.js";

/**
 * AsyncLocalStorage-based trace context for diagnostic events.
 *
 * Wrap hot-path entry points with `diagnosticTraceStore.run(ctx, fn)` to
 * establish a trace context that nested code can read via `currentTraceContext()`.
 * This avoids threading a `traceCtx` parameter through every function signature.
 */
export const diagnosticTraceStore = new AsyncLocalStorage<DiagnosticTraceContext>();

/** Create a new root trace context (new traceId + spanId). */
export function createTraceContext(): DiagnosticTraceContext {
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
  };
}

/**
 * Create a child trace context that shares the parent's traceId.
 * If no parent is provided, reads from AsyncLocalStorage.
 * If no context exists at all, creates a new root context.
 */
export function createChildContext(parent?: DiagnosticTraceContext): DiagnosticTraceContext {
  const p = parent ?? diagnosticTraceStore.getStore();
  return {
    traceId: p?.traceId ?? randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    parentSpanId: p?.spanId,
  };
}

/** Get the current trace context from AsyncLocalStorage, or undefined if none. */
export function currentTraceContext(): DiagnosticTraceContext | undefined {
  return diagnosticTraceStore.getStore();
}
