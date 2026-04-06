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
  "Enter plan mode and pause mutation tools for this session.";
export const EXIT_PLAN_MODE_TOOL_DISPLAY_SUMMARY =
  "Exit plan mode after the user confirms the plan.";
export const TODO_WRITE_TOOL_DISPLAY_SUMMARY =
  "Persist the current plan content and todo list for this session.";
export const TASK_CREATE_TOOL_DISPLAY_SUMMARY =
  "Create a session-scoped task from the current plan.";
export const TASK_UPDATE_TOOL_DISPLAY_SUMMARY = "Update a session-scoped task status or progress.";

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
    "Enter plan mode for the current session.",
    "This switches the session runtime mode to `plan`, clears any stale persisted plan state, and blocks mutation tools until the plan is confirmed.",
  ].join(" ");
}

export function describeExitPlanModeTool(): string {
  return [
    "Exit plan mode for the current session after the user confirms the plan.",
    "This switches the session runtime mode back to `normal` while keeping the last persisted plan for resume and audit.",
  ].join(" ");
}

export function describeTodoWriteTool(): string {
  return [
    "Persist the current plan content and structured todo list to session metadata.",
    "Use this to keep plan state durable across resume, compaction, or follow-up turns while plan mode is active.",
  ].join(" ");
}

export function describeTaskCreateTool(): string {
  return [
    "Create a session-scoped task record for plan execution.",
    "Use `todoId` to bind the task to an existing persisted todo item, or pass `task` directly for ad hoc execution work.",
  ].join(" ");
}

export function describeTaskUpdateTool(): string {
  return [
    "Update a task record created from the current session plan.",
    "Use this to move tasks between queued, running, and terminal states or to persist progress summaries while work continues.",
  ].join(" ");
}
