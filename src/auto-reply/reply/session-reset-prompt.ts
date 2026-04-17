import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. If bootstrap is still pending for this workspace, then before producing any user-visible reply you MUST read BOOTSTRAP.md from the workspace and follow it. Do not greet the user, offer help, answer the message, or reply normally until after you have read and are following BOOTSTRAP.md. Only once bootstrap is complete should you greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

const BARE_SESSION_RESET_BOOTSTRAP_PENDING_PROMPT_BASE =
  "A new session was started via /new or /reset while bootstrap is still pending for this workspace. Before producing any user-visible reply, you MUST read BOOTSTRAP.md from the workspace now and follow it. Do not greet the user, offer help, answer the message, or reply normally until after you have read and are following BOOTSTRAP.md. Your first user-visible reply must follow BOOTSTRAP.md, not a generic greeting. If the runtime model differs from default_model in the system prompt, mention the default model only after following BOOTSTRAP.md. Do not mention internal steps, files, tools, or reasoning.";

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

export function buildBareSessionResetBootstrapPendingPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
): string {
  return appendCronStyleCurrentTimeLine(
    BARE_SESSION_RESET_BOOTSTRAP_PENDING_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
