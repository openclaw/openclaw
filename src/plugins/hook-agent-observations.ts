import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type { VoidHookRunOptions } from "./hook-runner-types.js";
import type {
  PluginHookAgentContext,
  PluginHookAgentEndEvent,
  PluginHookRunFailedEvent,
  PluginHookRunFailedContext,
} from "./hook-types.js";

export function withAgentRunId<TEvent extends { runId?: string }>(
  event: TEvent,
  ctx: PluginHookAgentContext,
): TEvent {
  if (event.runId || !ctx.runId) {
    return event;
  }
  return { ...event, runId: ctx.runId };
}

/** Terminal hooks release per-run state and settle work, even for private runs. */
export function projectAgentEndEvent(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): PluginHookAgentEndEvent {
  const observedEvent = isIncognitoSessionKey(ctx.sessionKey)
    ? { runId: event.runId, messages: [], success: event.success, durationMs: event.durationMs }
    : event;
  return withAgentRunId(observedEvent, ctx);
}

/** Exclude optional prompt/response observers without changing policy hooks. */
export function withoutIncognitoLlmContent<TEvent>(
  run: (event: TEvent, ctx: PluginHookAgentContext) => Promise<void>,
) {
  return async (event: TEvent, ctx: PluginHookAgentContext): Promise<void> => {
    if (!isIncognitoSessionKey(ctx.sessionKey)) {
      await run(event, ctx);
    }
  };
}

/** Keep terminal observation projections with the other privacy-aware observers. */
export function createAgentEndHook(
  run: (
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
    options?: VoidHookRunOptions,
  ) => Promise<void>,
) {
  return (
    event: PluginHookAgentEndEvent,
    ctx: PluginHookAgentContext,
    options?: VoidHookRunOptions,
  ) => run(projectAgentEndEvent(event, ctx), ctx, options);
}

/** Failure receipts contain conversation content, unlike the redacted agent-end projection. */
export function createRunFailedHook(
  run: (event: PluginHookRunFailedEvent, ctx: PluginHookRunFailedContext) => Promise<void>,
) {
  return (event: PluginHookRunFailedEvent, ctx: PluginHookRunFailedContext) =>
    isIncognitoSessionKey(ctx.sessionKey) ? Promise.resolve() : run(event, ctx);
}
