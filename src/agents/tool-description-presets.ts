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
export const ASK_USER_QUESTION_TOOL_DISPLAY_SUMMARY =
  "Ask the user a multiple-choice question and pause for the answer.";
export const PLAN_MODE_STATUS_TOOL_DISPLAY_SUMMARY =
  "Inspect the current plan-mode state (read-only).";

export function describePlanModeStatusTool(): string {
  return [
    // Live-test iter-3 D6: introspection tool the agent can call to
    // self-diagnose plan-mode state without inferring from tool errors.
    "Read-only inspection of the current plan-mode state for the active session.",
    "Returns: inPlanMode, approval phase, title, openSubagentCount + IDs, plan step count, recentlyApprovedAt, pendingAgentInjection preview, planModeIntroDeliveredAt, autoApprove, debugLogEnabled.",
    "Use this when: you want to verify your current plan-mode state before submitting / approving / continuing; the user asks 'what's my plan-mode state?'; debugging why a tool was blocked; verifying approval, restart, or nudge behavior during troubleshooting.",
    "ALWAYS read-only — never mutates plan-mode state, never consumes pendingAgentInjection, safe to call mid-pending-approval.",
  ].join(" ");
}

export function describeAskUserQuestionTool(): string {
  return [
    "Ask the user a clarifying question with 2-6 selectable options.",
    "The runtime emits a pending question interaction and pauses your run until the user answers. Control UI shows an inline card; non-web channels answer through `/plan answer` text commands (or free text when allowed).",
    "The chosen answer arrives in your next turn as a synthetic user message tagged `[QUESTION_ANSWER]: <answer text>`.",
    "USE FOR: tradeoffs you cannot resolve via local investigation (product/scope choices, design preferences, organizational priorities, ambiguous user intent).",
    "DO NOT USE FOR: things you could grep / read / web_search yourself, trivial defaults already covered by AGENTS.md, or confirmation requests (that's what exit_plan_mode does).",
    "Plan-mode safe: asking a question DOES NOT exit plan mode. The session stays armed and you can submit `exit_plan_mode` after receiving the answer.",
    "Pass `allowFreetext: true` to add an 'Other...' affordance when your N options might not cover the user's intent.",
  ].join(" ");
}

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
    // Live-test iter-2 Bug F: agent confused this with exit_plan_mode.
    // Make the contract explicit: this tool TRACKS, it does NOT submit.
    "TRACKING ONLY — this tool does NOT submit the plan for approval. Mutations stay BLOCKED while in plan mode. Call exit_plan_mode (NOT update_plan) when you're ready to propose the plan to the user.",
    "Use this for non-trivial multi-step work so the plan stays current while execution continues.",
    "Keep steps short, mark at most one step as `in_progress`, and skip this tool for simple one-step tasks.",
    // Iter-3 D3: pointer to the bootstrap-injected reference card +
    // self-test command so agents have a single source of truth for
    // plan-mode lifecycle/tag-taxonomy/debugging.
    "For the full plan-mode reference (state diagram, [PLAN_*]: tag taxonomy, /plan slash commands, common pitfalls, debugging tips): see the bootstrap-injected reference card visible on every in-mode turn. To inspect live plan-mode state at runtime, call `plan_mode_status` (read-only diagnostic).",
  ].join(" ");
}

export function describeEnterPlanModeTool(): string {
  return [
    "Enter plan mode for this session.",
    "Mutation tools (write, edit, exec, bash, sessions_send, etc.) become BLOCKED until you call exit_plan_mode and the user approves the proposed plan.",
    "Read-only tools (read, web_search, web_fetch, update_plan) remain available so you can investigate before proposing changes.",
    "Use this when the user explicitly asks for a plan-first workflow, or when the agent wants to confirm a multi-step change before executing.",
    // Live-test iter-2 Bug F: lifecycle clarity. Agent demonstrably
    // misordered tool calls (called update_plan with all-terminal
    // steps and expected approval card; called exit_plan_mode then
    // posted more chat). Spell out the lifecycle so the agent treats
    // these tools as a small state machine.
    "TOOL LIFECYCLE — use the right tool for the right phase: " +
      "(1) enter_plan_mode = ONCE at the start of a planning cycle (no-op if already in plan mode). " +
      "(2) update_plan = DURING investigation/execution to track progress (steps + status). Does NOT submit. " +
      "(3) exit_plan_mode = ONCE when ready to propose. Submits the plan for user approval. " +
      "After approval, mutations unlock — continue executing without re-entering plan mode unless the user requests a NEW planning cycle.",
    // Iter-3 D3: pointer to reference card + self-test for full context.
    "For the full plan-mode reference (state diagram, [PLAN_*]: tag taxonomy, /plan slash commands, common pitfalls, debugging tips): see the bootstrap-injected reference card visible on every in-mode turn. To inspect live plan-mode state at runtime, call `plan_mode_status` (read-only diagnostic).",
  ].join(" ");
}

export function describeExitPlanModeTool(): string {
  return [
    // Live-test iter-2 Bug A + Bug F: this is the FIRST and most
    // important rule. The agent kept emitting chat text after
    // exit_plan_mode in the same turn, which (combined with the
    // post-approval planMode-deletion stale-cache bug) broke the
    // approval flow end-to-end. Hard-stop the agent immediately
    // after the tool call.
    "STOP AFTER THIS TOOL CALL — do NOT emit any further assistant text in the same turn. The exit_plan_mode call IS your final action; trailing chat text breaks the approval card lifecycle and the user gets stuck. If you want to give context, put it BEFORE the tool call OR inside the tool's `summary`/`analysis` fields.",
    "REQUIRED when the session is in plan mode: submits the proposed plan to the user for Approve/Edit/Reject.",
    "When the user asks for a plan while in plan mode, your reply MUST be a brief acknowledgement followed by an exit_plan_mode tool call — do NOT write the plan as a markdown list in chat text, that bypasses the approval flow.",
    // PR-8 follow-up: belt-and-suspenders steer paired with a hard-block
    // runtime check. Eva's post-mortem flagged treating "research
    // launched" as "research complete" as the exact bug this prevents.
    "WAIT FOR SPAWNED SUBAGENTS BEFORE CALLING THIS TOOL. If you used sessions_spawn during plan-mode investigation (research, adversarial review, etc.), wait for ALL of them to return their completion messages before calling exit_plan_mode. The runtime rejects submission with an error listing pending child run ids if any are still in flight. Treat unresolved children as a blocking dependency of the investigation phase — 'research launched' is not 'research complete.'",
    "Pass the full plan via `plan` using the same shape as update_plan (array of {step, status, activeForm?}).",
    // PR-9 Tier 1: explicit title field. Without this, the agent's chat
    // text leaked into the title slot ("I checked all five VMs..." as
    // the plan title). Title belongs in the tool call, not in chat.
    'ALSO PASS `title` (under 80 chars) — a concise plan name used as the approval-card header AND the persisted markdown filename slug. Examples: "Migrate VM provisioning to golden snapshot", "Fix websocket reconnect race in PR-67721". Do NOT put plan content in `title` — that goes in `plan` and `summary`.',
    "Optionally pass `summary` (one sentence) — surfaced as the subtitle next to the title.",
    "The runtime emits an approval card; the user can Approve (mutations unlock and you proceed), Approve with edits (same), Reject with feedback (you stay in plan mode and revise; feedback arrives in your next turn as [PLAN_DECISION]: rejected), or let it Time Out.",
    "Calling this without an active plan-mode session is a no-op; calling it without `plan` content is rejected.",
    // Iter-3 D3: pointer to reference card + self-test for full context.
    "For the full plan-mode reference (state diagram, [PLAN_*]: tag taxonomy, /plan slash commands, common pitfalls, debugging tips): see the bootstrap-injected reference card visible on every in-mode turn. To inspect live plan-mode state at runtime, call `plan_mode_status` (read-only diagnostic).",
  ].join(" ");
}
