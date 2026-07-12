// Emits per-plugin hook handler timing when process diagnostics are enabled.
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import type { PluginHookName } from "./hook-types.js";

type HookDiagnosticContext = {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export type HookHandlerDiagnosticIdentity = {
  pluginId: string;
  hookName: PluginHookName;
  handlerName?: string;
  handlerSource?: string;
  handlerRef: string;
};

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function resolveCallableName(fn: (...args: unknown[]) => unknown): string | undefined {
  const name = fn.name?.trim();
  if (!name || name === "anonymous") {
    return undefined;
  }
  if (name.startsWith("bound ")) {
    const unbound = name.slice("bound ".length).trim();
    return unbound || undefined;
  }
  return name;
}

export function buildHookHandlerRef(params: {
  pluginId: string;
  hookName: string;
  handlerName?: string;
  handlerSource?: string;
}): string {
  const pluginId = params.pluginId.trim() || "unknown";
  const hookName = params.hookName.trim() || "hook";
  const base = `hook:${pluginId}:${hookName}`;
  if (params.handlerName?.trim()) {
    return `${base}@${params.handlerName.trim()}`;
  }
  if (params.handlerSource?.trim()) {
    return `${base}#${params.handlerSource.trim()}`;
  }
  return base;
}

export function resolveHookHandlerDiagnosticIdentity(hook: {
  pluginId: string;
  hookName: PluginHookName;
  handler: (...args: unknown[]) => unknown;
  source?: string;
}): HookHandlerDiagnosticIdentity {
  const handlerName = resolveCallableName(hook.handler);
  const handlerSource = hook.source?.trim() ? path.basename(hook.source.trim()) : undefined;
  return {
    pluginId: hook.pluginId,
    hookName: hook.hookName,
    handlerName,
    handlerSource,
    handlerRef: buildHookHandlerRef({
      pluginId: hook.pluginId,
      hookName: hook.hookName,
      handlerName,
      handlerSource,
    }),
  };
}

function resolveHookDiagnosticContext(event: unknown, ctx: unknown): HookDiagnosticContext {
  const fromRecord = (value: unknown): HookDiagnosticContext => {
    if (typeof value !== "object" || value === null) {
      return {};
    }
    const record = value as {
      runId?: string;
      sessionKey?: string;
      sessionId?: string;
    };
    return {
      runId: record.runId,
      sessionKey: record.sessionKey,
      sessionId: record.sessionId,
    };
  };
  const eventCtx = fromRecord(event);
  const handlerCtx = fromRecord(ctx);
  return {
    runId: eventCtx.runId ?? handlerCtx.runId,
    sessionKey: eventCtx.sessionKey ?? handlerCtx.sessionKey,
    sessionId: eventCtx.sessionId ?? handlerCtx.sessionId,
  };
}

function emitHookHandlerCompleted(params: {
  identity: HookHandlerDiagnosticIdentity;
  durationMs: number;
  outcome: "completed" | "error";
  context: HookDiagnosticContext;
}): void {
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  emitDiagnosticEvent({
    type: "hook.handler.completed",
    hookName: params.identity.hookName,
    pluginId: params.identity.pluginId,
    ...(params.identity.handlerName ? { handlerName: params.identity.handlerName } : {}),
    ...(params.identity.handlerSource ? { handlerSource: params.identity.handlerSource } : {}),
    handlerRef: params.identity.handlerRef,
    durationMs: params.durationMs,
    outcome: params.outcome,
    runId: params.context.runId,
    sessionKey: params.context.sessionKey,
    sessionId: params.context.sessionId,
  });
}

type HookHandlerDiagnosticRegistration = {
  pluginId: string;
  hookName: PluginHookName;
  handler: (...args: unknown[]) => unknown;
  source?: string;
};

/** Runs one synchronous plugin hook handler and records trusted timing diagnostics. */
export function invokeSyncHookHandlerWithDiagnostics<T>(params: {
  hook: HookHandlerDiagnosticRegistration;
  event: unknown;
  ctx: unknown;
  invoke: () => T;
}): T {
  const identity = resolveHookHandlerDiagnosticIdentity(params.hook);
  const context = resolveHookDiagnosticContext(params.event, params.ctx);
  const started = performance.now();
  let outcome: "completed" | "error" = "completed";
  try {
    return params.invoke();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    emitHookHandlerCompleted({
      identity,
      durationMs: roundMs(performance.now() - started),
      outcome,
      context,
    });
  }
}

/** Runs one plugin hook handler and records trusted timing diagnostics. */
export async function invokeHookHandlerWithDiagnostics<T>(params: {
  hook: HookHandlerDiagnosticRegistration;
  event: unknown;
  ctx: unknown;
  invoke: () => Promise<T> | T;
}): Promise<T> {
  const identity = resolveHookHandlerDiagnosticIdentity(params.hook);
  const context = resolveHookDiagnosticContext(params.event, params.ctx);
  const started = performance.now();
  let outcome: "completed" | "error" = "completed";
  try {
    return await params.invoke();
  } catch (error) {
    outcome = "error";
    throw error;
  } finally {
    emitHookHandlerCompleted({
      identity,
      durationMs: roundMs(performance.now() - started),
      outcome,
      context,
    });
  }
}
