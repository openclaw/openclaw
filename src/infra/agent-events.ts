import type { VerboseLevel } from "../auto-reply/thinking.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

export type AgentEventStream =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "error"
  | "item"
  | "plan"
  | "approval"
  | "command_output"
  | "patch"
  | "compaction"
  | "thinking"
  | (string & {});

export type AgentItemEventPhase = "start" | "update" | "end";
export type AgentItemEventStatus = "running" | "completed" | "failed" | "blocked";
export type AgentItemEventKind =
  | "tool"
  | "command"
  | "patch"
  | "search"
  | "analysis"
  | (string & {});

export type AgentItemEventData = {
  itemId: string;
  phase: AgentItemEventPhase;
  kind: AgentItemEventKind;
  title: string;
  status: AgentItemEventStatus;
  name?: string;
  meta?: string;
  toolCallId?: string;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  summary?: string;
  progressText?: string;
  approvalId?: string;
  approvalSlug?: string;
};

export type AgentPlanEventData = {
  /**
   * - "update": normal plan update from `update_plan` (also fires on
   *   plan-template seed and planning-only retry detection).
   * - "completed": PR-9 Wave A2 — emitted by `update_plan` when every
   *   step in the merged plan has terminal status (`completed` or
   *   `cancelled`). The gateway-side persister listens for this phase
   *   and auto-flips `SessionEntry.planMode.mode` back to `"normal"`
   *   so mutations stay unlocked and the user-visible "plan complete"
   *   state is consistent with persisted session state.
   */
  phase: "update" | "completed";
  title: string;
  explanation?: string;
  /** Step labels only (legacy). Kept for backwards compatibility. */
  steps?: string[];
  /**
   * PR-10 review fix (Codex P2 #3104743333 escalated → option C):
   * full structured merged plan after `update_plan` execution
   * (status / activeForm / acceptanceCriteria / verifiedCriteria).
   *
   * Pre-fix the UI sidebar refresh in `app-tool-stream.ts` read
   * `data.args` (the tool INPUT at start time). Under
   * `update_plan { merge: true }` the input is a delta, not the merged
   * result, so the sidebar drifted out of sync with the actual plan
   * state. Solving via a structured `mergedSteps` field on the
   * existing `agent_plan_event` channel — no new event type, no
   * SessionEntry hot-path read, and the persister already subscribes
   * to this stream so its own logic doesn't change.
   *
   * UI subscribers should prefer this over the legacy `steps`
   * field when present.
   */
  mergedSteps?: Array<{
    step: string;
    status: string;
    activeForm?: string;
    acceptanceCriteria?: string[];
    verifiedCriteria?: string[];
  }>;
  source?: string;
};

export type AgentApprovalEventPhase = "requested" | "resolved";
export type AgentApprovalEventStatus = "pending" | "unavailable" | "approved" | "denied" | "failed";
export type AgentApprovalEventKind = "exec" | "plugin" | "unknown";

/**
 * Plan-step shape carried by plan-kind approval events (PR-8 follow-up).
 * Mirrors the runtime `update_plan` step shape but kept independent so
 * `agent-events.ts` doesn't depend on the agents layer.
 */
export type AgentApprovalPlanStep = {
  step: string;
  status: string;
  activeForm?: string;
};

export type AgentApprovalEventData = {
  phase: AgentApprovalEventPhase;
  kind: AgentApprovalEventKind;
  status: AgentApprovalEventStatus;
  title: string;
  itemId?: string;
  toolCallId?: string;
  approvalId?: string;
  approvalSlug?: string;
  command?: string;
  host?: string;
  reason?: string;
  message?: string;
  /**
   * Plan-mode approval payload (PR-8). Present only when `kind === "plugin"`
   * and the underlying tool was `exit_plan_mode`. The UI/channel renderers
   * use this to show the plan checklist with Approve/Reject/Edit buttons.
   */
  plan?: AgentApprovalPlanStep[];
  /** One-line summary the agent included with the proposed plan. */
  summary?: string;
  // PR-10 plan-archetype fields. All optional and additive — channel
  // renderers / UI cards display them when present, fall back to
  // plan + summary when omitted.
  /** Markdown body explaining current state, chosen approach, and rationale. */
  analysis?: string;
  /** Explicit assumptions made during planning. */
  assumptions?: string[];
  /** Risk register with mitigations. */
  risks?: Array<{ risk: string; mitigation: string }>;
  /** Concrete steps that will confirm the plan succeeded. */
  verification?: string[];
  /** File paths, URLs, PR numbers, doc references the plan builds on. */
  references?: string[];
  /**
   * PR-10 AskUserQuestion: when present, this approval is a clarifying
   * question rather than a plan submission. UI renders the question +
   * one button per option; the chosen answer is routed back via
   * sessions.patch { planApproval: { action: "answer", answer: <choice> }}.
   * `kind` stays "plugin" — the approval pipeline is shared.
   */
  question?: {
    prompt: string;
    options: string[];
    allowFreetext?: boolean;
    /**
     * Stable id for this question (separate from approvalId) so the UI
     * can correlate option text → answer when freetext is also allowed.
     */
    questionId?: string;
  };
};

export type AgentCommandOutputEventData = {
  itemId: string;
  phase: "delta" | "end";
  title: string;
  toolCallId: string;
  name?: string;
  output?: string;
  status?: AgentItemEventStatus | "running";
  exitCode?: number | null;
  durationMs?: number;
  cwd?: string;
};

export type AgentPatchSummaryEventData = {
  itemId: string;
  phase: "end";
  title: string;
  toolCallId: string;
  name?: string;
  added: string[];
  modified: string[];
  deleted: string[];
  summary: string;
};

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

/**
 * Snapshot of a plan step persisted on the run context for #67514's
 * merge mode. Stored as a structural type to avoid pulling agent/tool
 * types into the infra layer. The string-typed `status` matches the
 * runtime `PLAN_STEP_STATUSES` union exported from
 * `src/agents/tools/update-plan-tool.ts`.
 */
export type PlanStepSnapshot = {
  step: string;
  status: string;
  activeForm?: string;
  /**
   * PR-9 Wave B1 — closure gate. Optional list of acceptance criteria
   * the agent must explicitly verify before this step can transition to
   * `status: "completed"`. When present, `update_plan` rejects the
   * transition unless `verifiedCriteria` covers every entry in
   * `acceptanceCriteria` (string-equality match).
   *
   * Backwards-compatible: omit both fields and the step behaves
   * identically to the prior shape (no gating).
   */
  acceptanceCriteria?: string[];
  /**
   * Strings from `acceptanceCriteria` the agent has explicitly checked
   * against live state. The agent calls `update_plan` with the same
   * step text plus an updated `verifiedCriteria` array as it confirms
   * each criterion (e.g., after running a verification command).
   */
  verifiedCriteria?: string[];
};

export type AgentRunContext = {
  sessionKey?: string;
  verboseLevel?: VerboseLevel;
  isHeartbeat?: boolean;
  /** Whether control UI clients should receive chat/agent updates for this run. */
  isControlUiVisible?: boolean;
  /** Timestamp when this context was first registered (for TTL-based cleanup). */
  registeredAt?: number;
  /** Timestamp of last activity (updated on every emitAgentEvent). */
  lastActiveAt?: number;
  /**
   * Last plan steps seen by `update_plan` in this run (#67514). Used by
   * merge mode to compute the merged plan against the previous state.
   * In-memory only — survives within a run, cleared with the context.
   * Disk-persistence (cross-session) is owned by `PlanStore` (#67542).
   */
  lastPlanSteps?: PlanStepSnapshot[];
  /**
   * PR-8 follow-up: set of child subagent run ids spawned by this run
   * that have not completed yet. Populated by `sessions_spawn` at spawn
   * time and drained by the subagent completion hook. `exit_plan_mode`
   * consults this set to reject plan submission while research children
   * are in flight — matches the user's explicit rule "wait for all
   * expected research children before submitting the plan".
   *
   * Stored as a `Set` so spawn/complete are O(1); ordering is not
   * semantically meaningful, only membership.
   */
  openSubagentRunIds?: Set<string>;
  /**
   * PR-8 follow-up: whether the parent session is currently in plan mode
   * (mirrored from `SessionEntry.planMode.mode === "plan"` at context
   * registration). Used by `sessions_spawn` to force `cleanup: "keep"`
   * on plan-mode-spawned children so they stay visible in the session
   * menu for the user to inspect during plan synthesis. Kept on the
   * context to avoid a session-store read on every spawn.
   */
  inPlanMode?: boolean;
  /**
   * PR-8 follow-up Round 2: current plan-approval state mirrored from
   * `SessionEntry.planMode.approval`. Used by the yield-after-approval
   * detector (`resolveYieldDuringApprovedPlanInstruction`) to decide
   * whether an unexplained yield should trigger a "continue execution"
   * retry steer. Values: `"none" | "pending" | "approved" | "edited" |
   * "rejected" | "timed_out"`.
   */
  planApproval?: string;
  /**
   * PR-11 review fix (Codex P2 #3105311664 — escalation cluster):
   * epoch-ms timestamp from `SessionEntry.recentlyApprovedAt`,
   * mirrored at context-registration time. Lets the yield-after-approval
   * detector fire within the post-approval grace window even AFTER
   * sessions.patch has cleared planMode (mode → "normal" deletes the
   * planMode object, so `planApproval` becomes undefined — this field
   * survives that cleanup because it's written at the SessionEntry
   * root level).
   */
  recentlyApprovedAt?: number;
  /**
   * PR-15: synthetic user-message text mirrored from
   * `SessionEntry.pendingAgentInjection`. The runtime prepends this to
   * the user's next-turn input AND clears the field via
   * `sessions.patch` so the injection only fires once.
   *
   * Single source of truth for inject-on-next-turn signals — written
   * by gateway-side handlers like `sessions.patch { planApproval:
   * action: "answer" }` (`[QUESTION_ANSWER]: <text>`),
   * `action: "approve"/"edit"/"reject"` (`[PLAN_DECISION]: ...`).
   * Replaces the prior pattern where each caller (webchat /
   * Telegram / Discord / Slack `/plan answer` paths) had to inject
   * via the channel's message-send infrastructure (which leaked the
   * synthetic marker into user-visible chat history).
   */
  pendingAgentInjection?: string;
  /**
   * Bug 3+4 fix: live-read accessor for the session's current planMode.
   * Returns the LATEST mode from the in-memory SessionEntry on every
   * call (O(1) map lookup, no disk I/O), bypassing the stale
   * `inPlanMode`/`planApproval` snapshots captured at run-start.
   *
   * Used by the mutation gate (`pi-tools.before-tool-call.ts`) to
   * avoid the cached-state divergence where:
   *   1. Agent enters plan mode → ctx.planMode === "plan" cached
   *   2. Agent submits exit_plan_mode → user approves
   *   3. sessions.patch flips SessionEntry.planMode → "normal"
   *   4. Same agent run continues executing
   *   5. ctx.planMode is STILL "plan" → mutation gate blocks
   *      mutations even though approval already cleared the gate
   *
   * Returning `undefined` is fine — caller falls back to the cached
   * snapshot. Optional so test contexts and unit fixtures don't have
   * to provide it.
   */
  getLatestPlanMode?: () => "plan" | "normal" | undefined;
  /**
   * Live-read accessor for `SessionEntry.postApprovalPermissions.
   * acceptEdits`. Returns `true` only when the user approved the plan
   * with "Accept, allow edits" (granting the agent permission to
   * self-modify the plan at ≥95% confidence). Used by the acceptEdits
   * constraint gate to block destructive / self-restart / config-
   * change actions even when general normal-mode execution is allowed.
   */
  getLatestAcceptEdits?: () => boolean;
  /**
   * Timestamp (ms since epoch) of the most-recent `openSubagentRunIds`
   * drain-to-zero event. Used by the subagent grace-window gate in
   * `exit_plan_mode` and in `sessions.patch { planApproval }` so a
   * parent can't submit a plan OR the user can't approve one in the
   * instant after a subagent completion — the short window lets
   * completion events propagate and announce-turns settle before the
   * approval flow proceeds.
   *
   * Undefined when no subagent has ever been spawned (or completed) in
   * this run. The grace gate short-circuits on undefined (no grace
   * window to enforce).
   */
  lastSubagentSettledAt?: number;
};

type AgentEventState = {
  seqByRun: Map<string, number>;
  listeners: Set<(evt: AgentEventPayload) => void>;
  runContextById: Map<string, AgentRunContext>;
  persistPlanModeSubagentGateState?: (
    params: PersistPlanModeSubagentGateStateParams,
  ) => Promise<void> | void;
};

const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");

type PersistPlanModeSubagentGateStateParams = {
  sessionKey?: string;
  mutate: (planMode: {
    blockingSubagentRunIds?: string[];
    lastSubagentSettledAt?: number;
    updatedAt?: number;
    mode?: string;
  }) => void;
};

function getAgentEventState(): AgentEventState {
  return resolveGlobalSingleton<AgentEventState>(AGENT_EVENT_STATE_KEY, () => ({
    seqByRun: new Map<string, number>(),
    listeners: new Set<(evt: AgentEventPayload) => void>(),
    runContextById: new Map<string, AgentRunContext>(),
    persistPlanModeSubagentGateState: undefined,
  }));
}

function persistPlanModeSubagentGateState(params: PersistPlanModeSubagentGateStateParams): void {
  if (!params.sessionKey) {
    return;
  }
  const handler = getAgentEventState().persistPlanModeSubagentGateState;
  if (!handler) {
    return;
  }
  void Promise.resolve(handler(params)).catch(() => {
    // best-effort only; approval gate still has the in-memory fallback
  });
}

export function setPlanModeSubagentGatePersistenceHandler(
  handler: AgentEventState["persistPlanModeSubagentGateState"],
): () => void {
  const state = getAgentEventState();
  state.persistPlanModeSubagentGateState = handler;
  return () => {
    if (state.persistPlanModeSubagentGateState === handler) {
      state.persistPlanModeSubagentGateState = undefined;
    }
  };
}

export function trackOpenSubagentForParent(parentRunId: string, childRunId: string): void {
  if (!parentRunId || !childRunId) {
    return;
  }
  const ctx = getAgentEventState().runContextById.get(parentRunId);
  if (!ctx) {
    return;
  }
  if (!ctx.openSubagentRunIds) {
    ctx.openSubagentRunIds = new Set();
  }
  ctx.openSubagentRunIds.add(childRunId);
  delete ctx.lastSubagentSettledAt;
  if (ctx.inPlanMode === true && ctx.sessionKey) {
    persistPlanModeSubagentGateState({
      sessionKey: ctx.sessionKey,
      mutate: (planMode) => {
        const nextIds = new Set(planMode.blockingSubagentRunIds ?? []);
        nextIds.add(childRunId);
        planMode.blockingSubagentRunIds = [...nextIds];
        delete planMode.lastSubagentSettledAt;
      },
    });
  }
}

export function replaceOpenSubagentRunIdInParents(previousRunId: string, nextRunId: string): void {
  if (!previousRunId || !nextRunId || previousRunId === nextRunId) {
    return;
  }
  const state = getAgentEventState();
  for (const ctx of state.runContextById.values()) {
    const set = ctx.openSubagentRunIds;
    if (!set || !set.has(previousRunId)) {
      continue;
    }
    set.delete(previousRunId);
    set.add(nextRunId);
    if (ctx.inPlanMode === true && ctx.sessionKey) {
      persistPlanModeSubagentGateState({
        sessionKey: ctx.sessionKey,
        mutate: (planMode) => {
          const nextIds = new Set(planMode.blockingSubagentRunIds ?? []);
          if (!nextIds.delete(previousRunId)) {
            return;
          }
          nextIds.add(nextRunId);
          planMode.blockingSubagentRunIds = [...nextIds];
        },
      });
    }
  }
}

/**
 * PR-8 follow-up: called by the subagent registry when a child run ends.
 * Scans all registered parent run contexts and removes the completed
 * child's runId from any `openSubagentRunIds` set it appears in. The
 * typical concurrency is 1-3 open children per parent, so an O(N) scan
 * across parents is cheap (N is the number of concurrent active runs,
 * usually single digits).
 *
 * Keeps the drain logic in the same module that owns the set, rather
 * than exposing `AgentRunContext` internals to the registry layer.
 */
export function drainCompletedSubagentFromParents(childRunId: string): void {
  const state = getAgentEventState();
  const now = Date.now();
  for (const ctx of state.runContextById.values()) {
    const set = ctx.openSubagentRunIds;
    if (!set) {
      continue;
    }
    const hadChild = set.delete(childRunId);
    // Grace-window fix: when this drain brings the set to zero, stamp
    // the settle time so the exit_plan_mode tool-side gate and the
    // sessions.patch approval-side gate can both enforce a short
    // post-completion delay. Prevents the announce-turn-races-the-
    // approval-resume-turn failure mode.
    if (hadChild && set.size === 0) {
      ctx.lastSubagentSettledAt = now;
    }
    if (hadChild && ctx.inPlanMode === true && ctx.sessionKey) {
      persistPlanModeSubagentGateState({
        sessionKey: ctx.sessionKey,
        mutate: (planMode) => {
          const nextIds = new Set(planMode.blockingSubagentRunIds ?? []);
          nextIds.delete(childRunId);
          planMode.blockingSubagentRunIds = [...nextIds];
          if (nextIds.size === 0) {
            planMode.lastSubagentSettledAt = now;
          }
        },
      });
    }
  }
}

/**
 * PR-9 Wave A2: called by the gateway-side plan-snapshot persister
 * when a plan structurally completes (all steps terminal). Clears the
 * `inPlanMode` flag on every run context for the given session so that
 * subsequent `sessions_spawn` calls revert to default cleanup behavior
 * (no longer forced to `"keep"`) and `exit_plan_mode` would no longer
 * be expected.
 *
 * Looking up by sessionKey rather than runId because the same session
 * may have multiple concurrent runs (heartbeat + user turn) and we
 * want all of them to see the cleared state immediately.
 */
export function clearInPlanModeForSession(sessionKey: string): void {
  const state = getAgentEventState();
  for (const ctx of state.runContextById.values()) {
    if (ctx.sessionKey === sessionKey) {
      ctx.inPlanMode = false;
    }
  }
}

export function registerAgentRunContext(runId: string, context: AgentRunContext) {
  if (!runId) {
    return;
  }
  const state = getAgentEventState();
  const existing = state.runContextById.get(runId);
  if (!existing) {
    state.runContextById.set(runId, {
      ...context,
      registeredAt: context.registeredAt ?? Date.now(),
    });
    return;
  }
  if (context.sessionKey && existing.sessionKey !== context.sessionKey) {
    existing.sessionKey = context.sessionKey;
  }
  if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) {
    existing.verboseLevel = context.verboseLevel;
  }
  if (context.isControlUiVisible !== undefined) {
    existing.isControlUiVisible = context.isControlUiVisible;
  }
  if (context.isHeartbeat !== undefined && existing.isHeartbeat !== context.isHeartbeat) {
    existing.isHeartbeat = context.isHeartbeat;
  }
}

export function getAgentRunContext(runId: string) {
  return getAgentEventState().runContextById.get(runId);
}

export function clearAgentRunContext(runId: string) {
  const state = getAgentEventState();
  state.runContextById.delete(runId);
  state.seqByRun.delete(runId);
}

/**
 * Sweep stale run contexts that exceeded the given TTL.
 * Guards against orphaned entries when lifecycle "end"/"error" events are missed.
 */
export function sweepStaleRunContexts(maxAgeMs = 30 * 60 * 1000): number {
  const state = getAgentEventState();
  const now = Date.now();
  let swept = 0;
  for (const [runId, ctx] of state.runContextById.entries()) {
    // Use lastActiveAt (refreshed on every event) to avoid sweeping active runs.
    // Fall back to registeredAt, then treat missing timestamps as infinitely old.
    const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
    const age = lastSeen ? now - lastSeen : Infinity;
    if (age > maxAgeMs) {
      state.runContextById.delete(runId);
      state.seqByRun.delete(runId);
      swept++;
    }
  }
  return swept;
}

export function resetAgentRunContextForTest() {
  getAgentEventState().runContextById.clear();
  getAgentEventState().seqByRun.clear();
}

export function emitAgentEvent(event: Omit<AgentEventPayload, "seq" | "ts">) {
  const state = getAgentEventState();
  const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
  state.seqByRun.set(event.runId, nextSeq);
  const context = state.runContextById.get(event.runId);
  if (context) {
    context.lastActiveAt = Date.now();
  }
  const isControlUiVisible = context?.isControlUiVisible ?? true;
  const eventSessionKey =
    typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : undefined;
  const sessionKey = isControlUiVisible ? (eventSessionKey ?? context?.sessionKey) : undefined;
  const enriched: AgentEventPayload = {
    ...event,
    sessionKey,
    seq: nextSeq,
    ts: Date.now(),
  };
  notifyListeners(state.listeners, enriched);
}

export function emitAgentItemEvent(params: {
  runId: string;
  data: AgentItemEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "item",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentPlanEvent(params: {
  runId: string;
  data: AgentPlanEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "plan",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentApprovalEvent(params: {
  runId: string;
  data: AgentApprovalEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "approval",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentCommandOutputEvent(params: {
  runId: string;
  data: AgentCommandOutputEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "command_output",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function emitAgentPatchSummaryEvent(params: {
  runId: string;
  data: AgentPatchSummaryEventData;
  sessionKey?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "patch",
    data: params.data as unknown as Record<string, unknown>,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
  });
}

export function onAgentEvent(listener: (evt: AgentEventPayload) => void) {
  const state = getAgentEventState();
  return registerListener(state.listeners, listener);
}

export function resetAgentEventsForTest() {
  const state = getAgentEventState();
  state.seqByRun.clear();
  state.listeners.clear();
  state.runContextById.clear();
}
