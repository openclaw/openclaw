import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import type { PluginHookAgentContext, PluginHookAgentEndEvent } from "./hook-types.js";

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
