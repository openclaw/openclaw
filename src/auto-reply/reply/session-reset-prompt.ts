import path from "node:path";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildHandoffPromptSection,
  consumeModelHandoff,
} from "../../config/sessions/model-handoff.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Run your Session Startup sequence - read the required files before responding to the user. Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(cfg?: OpenClawConfig, nowMs?: number): string {
  return appendCronStyleCurrentTimeLine(
    BARE_SESSION_RESET_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/**
 * Consume a pending model-change handoff and return its content as a system
 * prompt section, or null if no handoff exists for this session.
 *
 * Called on the first turn of every new session so the new model always
 * receives handoff context — even when the user sends a normal message rather
 * than /new or /reset.  The handoff file is deleted after the first read
 * so subsequent turns are not affected.
 */
export function consumeHandoffAsSystemPrompt(params: {
  storePath?: string;
  sessionKey?: string;
}): string | null {
  if (!params.storePath || !params.sessionKey) {
    return null;
  }

  try {
    const sessionsDir = path.dirname(params.storePath);
    const handoff = consumeModelHandoff(sessionsDir, params.sessionKey);
    if (!handoff || handoff.recentUserMessages.length === 0) {
      return null;
    }
    return buildHandoffPromptSection(handoff);
  } catch {
    return null;
  }
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
