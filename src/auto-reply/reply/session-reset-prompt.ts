import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/config.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Before responding, read SESSION_STARTUP.md if it exists and follow it exactly. Only if it does not exist, run the normal Session Startup sequence. Then greet the user in your configured persona, if one is provided. Be yourself. Keep it to 1-2 short sentences and ask what they want to do. Do not mention internal steps, files, tools, or reasoning.";
const BARE_SESSION_RESET_REPLY = "新会话已开始。请直接告诉我你要做什么。";

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

export function buildBareSessionResetReply(): string {
  return BARE_SESSION_RESET_REPLY;
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
