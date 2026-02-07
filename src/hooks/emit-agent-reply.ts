import type { OpenClawConfig } from "../config/config.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";

/**
 * Emit an `agent:reply` hook event after an agent turn completes.
 * Shared across all code paths (auto-reply, CLI, cron, subagent).
 * Returns any messages pushed by hook handlers.
 */
export async function emitAgentReplyHook(opts: {
  cfg: OpenClawConfig;
  replyText: string;
  sessionKey: string;
  sessionId: string;
  channel?: string;
  to?: string;
  model?: string;
  provider?: string;
  toolMetas?: Array<{ toolName: string; meta?: string }>;
}): Promise<string[]> {
  if (!opts.cfg.hooks?.internal?.enabled) {
    return [];
  }
  try {
    const hookEvent = createInternalHookEvent("agent", "reply", opts.sessionKey, {
      replyText: opts.replyText,
      sessionId: opts.sessionId,
      channel: opts.channel,
      to: opts.to,
      model: opts.model,
      provider: opts.provider,
      toolMetas: opts.toolMetas ?? [],
    });
    await triggerInternalHook(hookEvent);
    return hookEvent.messages;
  } catch {
    return [];
  }
}
