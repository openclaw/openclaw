export const EXEC_TOOL_DISPLAY_SUMMARY = "Run shell commands that start now.";
export const PROCESS_TOOL_DISPLAY_SUMMARY = "Inspect and control running exec sessions.";
export const CRON_TOOL_DISPLAY_SUMMARY = "Schedule cron jobs, reminders, and wake events.";
export const SESSIONS_LIST_TOOL_DISPLAY_SUMMARY =
  "List visible sessions and optional recent messages.";
export const SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY =
  "Read sanitized message history for a visible session.";
export const SESSIONS_SEND_TOOL_DISPLAY_SUMMARY = "Send a message to another visible session.";
export const SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY = "Spawn sub-agent or ACP sessions.";
export const SESSION_STATUS_TOOL_DISPLAY_SUMMARY = "Show session status, usage, and model state.";
export const UPDATE_PLAN_TOOL_DISPLAY_SUMMARY = "Track a short structured work plan.";
export const ENTER_PLAN_MODE_TOOL_DISPLAY_SUMMARY =
  "Enter plan mode — block mutation tools until the user approves a plan.";
export const EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY =
  "Exit plan mode and request user approval of the proposed plan.";

export function describeSessionsListTool(): string {
  return [
    "List visible sessions with optional filters for kind, recent activity, and last messages.",
    "Use this to discover a target session before calling sessions_history or sessions_send.",
  ].join(" ");
}

export function describeSessionsHistoryTool(): string {
  return [
    "Fetch sanitized message history for a visible session.",
    "Supports limits and optional tool messages; use this to inspect another session before replying, debugging, or resuming work.",
  ].join(" ");
}

export function describeSessionsSendTool(): string {
  return [
    "Send a message into another visible session by sessionKey or label.",
    "Use this to delegate follow-up work to an existing session; waits for the target run and returns the updated assistant reply when available.",
  ].join(" ");
}

export function describeSessionsSpawnTool(): string {
  return [
    'Spawn an isolated session with `runtime="subagent"` or `runtime="acp"`.',
    '`mode="run"` is one-shot and `mode="session"` is persistent or thread-bound.',
    "Subagents inherit the parent workspace directory automatically.",
    "Use this when the work should happen in a fresh child session instead of the current one.",
  ].join(" ");
}

export function describeSessionStatusTool(): string {
  return [
    "Show a /status-equivalent session status card for the current or another visible session, including usage, time, cost when available, and linked background task context.",
    "Optional `model` sets a per-session model override; `model=default` resets overrides.",
    "Use this for questions like what model is active or how a session is configured.",
  ].join(" ");
}

export function describeUpdatePlanTool(): string {
  return [
    "Update the current structured work plan for this run.",
    "Use this for non-trivial multi-step work so the plan stays current while execution continues.",
    "Keep steps short, mark at most one step as `in_progress`, and skip this tool for simple one-step tasks.",
  ].join(" ");
}

export function describeEnterPlanModeTool(): string {
  return [
    "Enter plan mode for this session.",
    "Mutation tools (write, edit, exec, bash, sessions_send, etc.) become BLOCKED until you call exit_plan_mode and the user approves the proposed plan.",
    "Read-only tools (read, web_search, web_fetch, update_plan) remain available so you can investigate before proposing changes.",
    "Use this when the user explicitly asks for a plan-first workflow, or when the agent wants to confirm a multi-step change before executing.",
  ].join(" ");
}

export function describeExitPlanModeTool(): string {
  return [
    "Exit plan mode and request user approval of the proposed plan.",
    "Pass the current plan steps via `plan` (use the same shape as update_plan).",
    "The runtime emits an approval request — the user can Approve (mutations unlock), Reject with feedback (you stay in plan mode and revise), or let it Time Out.",
    "Call this only after you have proposed a plan via update_plan; calling it without a plan is rejected.",
  ].join(" ");
}
