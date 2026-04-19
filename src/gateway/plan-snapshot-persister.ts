/**
 * PR-8 follow-up: gateway-side listener that persists the live plan
 * snapshot onto `SessionEntry.planMode.lastPlanSteps` after each
 * `update_plan` tool call. Lets the Control UI rebuild the live-plan
 * sidebar after a hard refresh — without this, `latestPlanMarkdown`
 * lives only in in-memory `@state()` and is lost on page reload.
 *
 * Design: subscribes to agent events with `stream === "plan"`, looks up
 * the run context (already populated by `update-plan-tool.ts` before
 * the emit), and writes the snapshot through the existing
 * `applySessionsPatchToStore` seam so the write respects the same
 * validation + broadcast pipeline as user-initiated patches.
 *
 * The listener is wired in `server-runtime-subscriptions.ts` alongside
 * the existing agent/heartbeat/transcript/lifecycle subscriptions.
 */
import { logPlanModeDebug } from "../agents/plan-mode/plan-mode-debug-log.js";
import { loadConfig } from "../config/io.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import { updateSessionStore } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  clearInPlanModeForSession,
  getAgentRunContext,
  onAgentEvent,
} from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const log = createSubsystemLogger("gateway/plan-snapshot-persister");

export async function persistPlanModeSubagentGateState(params: {
  sessionKey?: string;
  mutate: (planMode: {
    blockingSubagentRunIds?: string[];
    lastSubagentSettledAt?: number;
    updatedAt?: number;
    mode?: string;
  }) => void;
}): Promise<void> {
  if (!params.sessionKey) {
    return;
  }
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: params.sessionKey });
  await updateSessionStore(target.storePath, async (store) => {
    const entry = store[params.sessionKey!];
    if (!entry?.planMode || entry.planMode.mode !== "plan") {
      return { ok: false as const };
    }
    const nextPlanMode = {
      ...entry.planMode,
      blockingSubagentRunIds: [...(entry.planMode.blockingSubagentRunIds ?? [])],
    };
    params.mutate(nextPlanMode);
    store[params.sessionKey!] = {
      ...entry,
      planMode: {
        ...nextPlanMode,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    return { ok: true as const };
  });
}

export function startPlanSnapshotPersister(params: {
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
}): () => void {
  // Live-test iteration 1 Bug 2 + Bug 3: also listen to "approval"
  // stream events (where `exit_plan_mode` emits the title + approvalId
  // + plan + archetype fields). Persist `title` + parent `runId` onto
  // SessionEntry.planMode so:
  //   • The Control UI side panel can ANCHOR on the actual plan name
  //     for the entire lifecycle (Bug 2).
  //   • `sessions-patch.ts` can look up the parent's
  //     `openSubagentRunIds` via `getAgentRunContext(approvalRunId)`
  //     to gate `approve`/`edit` actions while subagents are in
  //     flight (Bug 3).
  // This is a fire-and-forget side effect; the event still propagates
  // to all other subscribers normally.
  const unsubscribeApproval = onAgentEvent((evt) => {
    if (evt.stream !== "approval") {
      return;
    }
    const sessionKey = evt.sessionKey;
    if (!sessionKey) {
      return;
    }
    const data = evt.data as Record<string, unknown> | undefined;
    if (!data) {
      return;
    }
    // Only fire on the request phase of plan submissions (kind="plugin"
    // means tool-driven, the title field is set, and we have an
    // approvalId to track). Updates / completions don't carry a fresh
    // title; skip them.
    //
    // Iter-3 X2 typo fix: the actual event emits `phase: "requested"`
    // (past tense, see pi-embedded-subscribe.handlers.tools.ts:1660),
    // not `"request"`. Iter-1 D2 wiring had a silent typo here: the
    // persister listener skipped EVERY plan submission, so
    // SessionEntry.planMode.title and .approvalRunId were NEVER
    // persisted — which in turn broke the iter-1 approval-side
    // subagent gate (it reads approvalRunId from disk to look up
    // openSubagentRunIds; if approvalRunId is undefined, the gate
    // silently bypasses). User-reported live test 17:54-17:58
    // confirmed: plan_mode_status showed title="(unset)" right after
    // exit_plan_mode submitted with a real title; that's the smoking
    // gun. Accept BOTH phase values for robustness in case the event
    // shape changes again.
    const phase = typeof data.phase === "string" ? data.phase : undefined;
    const kind = typeof data.kind === "string" ? data.kind : undefined;
    const title = typeof data.title === "string" ? data.title : undefined;
    const approvalId = typeof data.approvalId === "string" ? data.approvalId : undefined;
    // Codex P2 review #68939 (2026-04-19): the `ask_user_question`
    // tool emits the same `kind: "plugin"` approval shape as
    // `exit_plan_mode`, with `title: "Agent has a question"` and
    // `plan: []` (empty array — see `pi-embedded-subscribe.handlers.
    // tools.ts:1753-1769`). Pre-fix, those question events tripped
    // `isPlanSubmission` and overwrote `SessionEntry.planMode.
    // approvalId/title` with question metadata. If a question event
    // landed during a pending plan approval window, the user's later
    // Approve/Reject from the existing plan card would get rejected
    // by the gateway as a stale approvalId. The fix: also require a
    // NON-EMPTY `plan` array — `plan: []` is the question-event
    // tell. The `data.question` field is also a stronger negative
    // signal (only questions set it), so the predicate explicitly
    // excludes any payload with `question` set.
    const hasQuestionShape = Boolean(
      data &&
      typeof data === "object" &&
      "question" in data &&
      (data as { question?: unknown }).question,
    );
    const planArray = Array.isArray(data.plan) ? data.plan : null;
    const isPlanSubmission =
      (phase === "requested" || phase === "request") &&
      kind === "plugin" &&
      title !== undefined &&
      title.length > 0 &&
      planArray !== null &&
      planArray.length > 0 &&
      !hasQuestionShape;
    // Codex P1 review #68939 (2026-04-19): when a question approval
    // event fires, persist its approvalId to
    // `SessionEntry.pendingQuestionApprovalId` so the
    // `sessions-patch.ts` answer branch can validate incoming
    // `/plan answer` patches against an actual pending question.
    // This is a SEPARATE branch from the plan-submission persist
    // path because question events have a different lifecycle
    // (they don't transition planMode at all — see Codex P2 fix
    // above).
    const isQuestionSubmission =
      (phase === "requested" || phase === "request") &&
      kind === "plugin" &&
      hasQuestionShape &&
      typeof approvalId === "string" &&
      approvalId.length > 0;
    if (isQuestionSubmission) {
      // Codex P2 review #68939 (2026-04-19): also extract the
      // question's options + allowFreetext from the event payload
      // so the answer-branch can validate the answer text against
      // the offered set. The event shape comes from
      // `pi-embedded-subscribe.handlers.tools.ts:1764-1769` —
      // `data.question = { prompt, options, allowFreetext }`.
      const questionData =
        data && typeof data === "object" && "question" in data
          ? ((data as { question?: unknown }).question as Record<string, unknown> | undefined)
          : undefined;
      const optionsRaw = questionData?.options;
      const persistedOptions = Array.isArray(optionsRaw)
        ? optionsRaw.filter((o): o is string => typeof o === "string")
        : [];
      const persistedAllowFreetext =
        typeof questionData?.allowFreetext === "boolean" ? questionData.allowFreetext : false;
      const persistedQuestionId =
        typeof questionData?.questionId === "string" ? questionData.questionId : undefined;
      const questionPrompt = typeof questionData?.prompt === "string" ? questionData.prompt : "";
      const titleText = typeof data.title === "string" ? data.title : "Agent has a question";
      logPlanModeDebug({
        kind: "tool_call",
        sessionKey,
        tool: "ask_user_question",
        runId: evt.runId,
        details: {
          approvalId,
          optionCount: persistedOptions.length,
          allowFreetext: persistedAllowFreetext,
        },
      });
      void persistPendingQuestionApprovalId({
        sessionKey,
        approvalId,
        questionId: persistedQuestionId,
        title: titleText,
        prompt: questionPrompt,
        options: persistedOptions,
        allowFreetext: persistedAllowFreetext,
        emitSessionsChanged: params.emitSessionsChanged,
      }).catch((err) => {
        log.warn(
          `pending question approvalId persist failed: sessionKey=${sessionKey} runId=${evt.runId} err=${String(err)}`,
        );
      });
      return;
    }
    if (!isPlanSubmission) {
      return;
    }
    // Live-test iteration 1 Bug 4: log the metadata persist trigger
    // so debug tail can correlate exit_plan_mode tool calls with
    // SessionEntry.planMode.title writes.
    logPlanModeDebug({
      kind: "tool_call",
      sessionKey,
      tool: "exit_plan_mode",
      runId: evt.runId,
      details: { title, approvalId },
    });
    void persistApprovalMetadata({
      sessionKey,
      title,
      approvalRunId: evt.runId,
      approvalId,
      emitSessionsChanged: params.emitSessionsChanged,
    }).catch((err) => {
      log.warn(
        `plan approval metadata persist failed: sessionKey=${sessionKey} runId=${evt.runId} err=${String(err)}`,
      );
    });
  });
  const unsubscribe = onAgentEvent((evt) => {
    if (evt.stream !== "plan") {
      return;
    }
    const sessionKey = evt.sessionKey;
    if (!sessionKey) {
      return;
    }
    const ctx = getAgentRunContext(evt.runId);
    const snapshot = ctx?.lastPlanSteps;
    if (!snapshot || snapshot.length === 0) {
      return;
    }
    // PR-9 Wave A2: when the plan-event phase is "completed", flip the
    // session out of plan mode in the same patch. The agent doesn't
    // need to call exit_plan_mode separately — completion is structural.
    // Mutations were already unlocked by the prior approval; this
    // ensures the session-state and UI reflect the closed plan.
    const phase =
      evt.data && typeof evt.data === "object" && "phase" in evt.data
        ? (evt.data as { phase?: unknown }).phase
        : undefined;
    const closeOnComplete = phase === "completed";
    // Fire-and-forget — the event handler itself is synchronous so the
    // emit path isn't blocked on disk I/O. A failure here loses
    // refresh-after-reload restoration for this update, but the live
    // stream still delivers the plan to open UI clients via the usual
    // event path.
    void persistSnapshot({
      sessionKey,
      snapshot,
      closeOnComplete,
      emitSessionsChanged: params.emitSessionsChanged,
    }).catch((err) => {
      log.warn(
        `plan snapshot persist failed: sessionKey=${sessionKey} runId=${evt.runId} err=${String(err)}`,
      );
    });
  });
  // Live-test iteration 1: combine the two unsubscribes so callers
  // get a single shutdown handle that tears down both listeners.
  return () => {
    unsubscribe();
    unsubscribeApproval();
  };
}

/**
 * Live-test iteration 1 Bug 2 + Bug 3: persist plan title + parent
 * runId from the `agent_approval_event` onto SessionEntry.planMode.
 *
 * Title (Bug 2): UI side panel + future channel renderers read this
 * to display the actual plan name throughout the lifecycle.
 *
 * approvalRunId (Bug 3): the gateway-side approval handler in
 * `sessions-patch.ts` reads this to look up the parent's
 * `openSubagentRunIds` via `getAgentRunContext` and reject
 * `approve`/`edit` actions while subagents are in flight.
 *
 * Fire-and-forget. Failure logs a warn but doesn't block the event
 * stream — the approval still propagates to the UI which can render
 * the card; the only loss is the persisted title/runId for the
 * post-approval window.
 */
async function persistApprovalMetadata(params: {
  sessionKey: string;
  title: string;
  approvalRunId: string;
  approvalId?: string;
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
}) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: params.sessionKey });
  // Direct in-place write rather than going through `applySessionsPatchToStore`
  // because (a) these fields are server-internal metadata captured from
  // an in-process agent event, not a client RPC, and (b) wire-schema
  // changes for purely internal persistence add bureaucracy without
  // benefit (per `src/gateway/protocol/CLAUDE.md` data-first / additive
  // protocol rules — extending the public contract for internal-only
  // metadata isn't justified). The existing planMode object is mutated
  // in place; if no planMode exists yet, the write is a no-op (the
  // approval event implies enter_plan_mode already created the entry).
  await updateSessionStore(target.storePath, async (store) => {
    const entry = store[params.sessionKey];
    if (!entry || !entry.planMode) {
      return { ok: false as const };
    }
    const nextEntry: SessionEntry = {
      ...entry,
      planMode: {
        ...entry.planMode,
        title: params.title,
        approvalRunId: params.approvalRunId,
        ...(params.approvalId ? { approvalId: params.approvalId } : {}),
        updatedAt: Date.now(),
      },
      ...(params.approvalId
        ? {
            pendingInteraction: {
              kind: "plan" as const,
              approvalId: params.approvalId,
              title: params.title,
              createdAt: Date.now(),
              status: "pending" as const,
              ...(entry.planMode.cycleId ? { cycleId: entry.planMode.cycleId } : {}),
            },
          }
        : {}),
      updatedAt: Date.now(),
    };
    store[params.sessionKey] = nextEntry;
    return { ok: true as const };
  });
  params.emitSessionsChanged?.({
    sessionKey: params.sessionKey,
    reason: "plan_approval_metadata_persist",
  });
}

/**
 * Codex P1 review #68939 (2026-04-19): persist a fresh
 * `pendingQuestionApprovalId` so the gateway's `/plan answer` patch
 * handler can validate the incoming approvalId. Direct in-place
 * write (same rationale as `persistApprovalMetadata` above —
 * server-internal metadata, no public protocol surface needed).
 *
 * This is best-effort fire-and-forget — if the write fails (e.g.,
 * the session was deleted between the question event and the
 * persist), the answer-validation path will reject the answer with
 * a friendly "no pending question" error. That's the safe failure
 * mode (better to silently drop a stale answer than silently
 * overwrite a fresh injection).
 */
async function persistPendingQuestionApprovalId(params: {
  sessionKey: string;
  approvalId: string;
  questionId?: string;
  title: string;
  prompt: string;
  // Codex P2 review #68939 (2026-04-19): also persist options +
  // allowFreetext so the gateway's answer branch can enforce option-
  // membership validation when freetext is disabled.
  options: string[];
  allowFreetext: boolean;
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
}) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: params.sessionKey });
  await updateSessionStore(target.storePath, async (store) => {
    const entry = store[params.sessionKey];
    if (!entry) {
      return { ok: false as const };
    }
    const cycleId = entry.planMode?.cycleId;
    const nextEntry: SessionEntry = {
      ...entry,
      pendingInteraction: {
        kind: "question",
        approvalId: params.approvalId,
        ...(params.questionId ? { questionId: params.questionId } : {}),
        title: params.title,
        prompt: params.prompt,
        options: params.options,
        allowFreetext: params.allowFreetext,
        createdAt: Date.now(),
        status: "pending",
        ...(cycleId ? { cycleId } : {}),
      },
      updatedAt: Date.now(),
    };
    store[params.sessionKey] = nextEntry;
    return { ok: true as const };
  });
  params.emitSessionsChanged?.({
    sessionKey: params.sessionKey,
    reason: "pending_question_approval_id_persist",
  });
}

async function persistSnapshot(params: {
  sessionKey: string;
  snapshot: ReadonlyArray<{
    step: string;
    status: string;
    activeForm?: string;
    acceptanceCriteria?: string[];
    verifiedCriteria?: string[];
  }>;
  /**
   * PR-9 Wave A2: when true, also patch `planMode: "normal"` in the same
   * write — closing plan mode structurally so the agent doesn't have to
   * make a separate exit_plan_mode call. Triggered by `phase: "completed"`
   * events from `update_plan` when every step is terminal.
   *
   * PR-11 review fix (Codex P1 #3105389081): the close is now GATED on
   * the existence of an approved/edited plan-mode state. Without the
   * gate, a planning-phase `update_plan` (called BEFORE
   * `exit_plan_mode` ever fires) could mark all steps terminal and
   * trigger `closeOnComplete`, silently unlocking mutations without
   * any user approval. Reading `planMode.approval` from the live
   * session entry (or `recentlyApprovedAt` for the post-transition
   * window) ensures the auto-close only fires after a real approval.
   */
  closeOnComplete?: boolean;
  emitSessionsChanged?: (opts: { sessionKey: string; reason: string }) => void;
}) {
  const cfg = loadConfig();
  const target = resolveGatewaySessionStoreTarget({ cfg, key: params.sessionKey });
  // PR-11 review fix (Codex P1 #3105389081): pre-flight check for the
  // close gate. Read the entry BEFORE the patch fires to determine
  // whether the auto-close is authorized. The gate allows close when
  // either: (a) planMode.approval is "approved" or "edited" (we're in
  // the brief window before the approve patch flipped mode → normal),
  // OR (b) recentlyApprovedAt is within a reasonable window
  // (post-transition, planMode may be deleted). If neither holds, the
  // close is suppressed — the agent must explicitly call
  // exit_plan_mode + receive user approval to unlock mutations.
  let allowAutoClose = !params.closeOnComplete;
  if (params.closeOnComplete) {
    let existing: Record<string, unknown> | undefined;
    try {
      const existingStore = readSessionStoreReadOnly(target.storePath);
      existing = existingStore[params.sessionKey] as Record<string, unknown> | undefined;
    } catch {
      // If we can't read the store, default to disallowing auto-close
      // (fail-safe — prefer requiring explicit approval over silent
      // mutation unlock).
      existing = undefined;
    }
    const planMode = existing?.planMode as Record<string, unknown> | undefined;
    const approval = planMode?.approval;
    const cycleId = typeof planMode?.cycleId === "string" ? planMode.cycleId : undefined;
    const recentlyApprovedAt = existing?.recentlyApprovedAt;
    const recentlyApprovedCycleId =
      typeof existing?.recentlyApprovedCycleId === "string"
        ? existing.recentlyApprovedCycleId
        : undefined;
    const isRecentlyApproved =
      typeof recentlyApprovedAt === "number" && Date.now() - recentlyApprovedAt < 5 * 60_000;
    // Bug 5 fix: explicit pending guard. Without this, when a prior
    // plan cycle's `recentlyApprovedAt` is still within the 5-minute
    // window, ANY new `update_plan` with all-terminal steps would
    // auto-close — including during an ACTIVE pending approval (the
    // user has the dialog open but hasn't clicked yet). The close
    // would delete planMode → user click fires sessions.patch with a
    // stale approvalId → server rejects with "current state: none"
    // → user is stuck with an undismissable dialog.
    //
    // The guard: NEVER auto-close when there's an active pending
    // approval. The pending approval must be explicitly resolved
    // (approve/reject/edit/timeout) before any structural close.
    //
    // Codex P1 review #68939 (2026-04-19): tightened the
    // `isRecentlyApproved` grace window. Pre-fix, the predicate
    // `approval !== "rejected" && isRecentlyApproved` allowed a
    // brand-new plan cycle (planMode exists with approval === "none")
    // to auto-close on the prior cycle's stale `recentlyApprovedAt`
    // timestamp — bypassing the new cycle's mutation gate without an
    // explicit approval. The fix: only use the timestamp fallback
    // when there is NO current-cycle approval state (`approval` is
    // undefined — i.e., planMode itself is missing because a prior
    // close deleted it). When planMode exists with approval ===
    // "none" or "timed_out", the new cycle MUST be explicitly
    // approved before structural auto-close fires.
    if (approval === "pending") {
      allowAutoClose = false;
    } else if (approval === "approved" || approval === "edited") {
      // Explicit approval signal — close is the right next step.
      allowAutoClose = true;
    } else if (
      approval === undefined &&
      isRecentlyApproved &&
      recentlyApprovedCycleId &&
      !cycleId
    ) {
      // Post-deletion grace window: planMode is entirely missing
      // (prior close deleted it) but `recentlyApprovedAt` survives
      // at root for the 5-minute window. The runtime emitted a
      // late completion event after the close — accept the close
      // as the structural answer. No new cycle has started, so
      // there's no fresh approval state to violate.
      allowAutoClose = true;
    } else {
      // approval === "none", "rejected", or "timed_out" — a new
      // cycle is in flight (or the user said no). Do not auto-close.
      allowAutoClose = false;
    }
  }
  // Bug 6 fix: when the plan auto-closes, also emit a [PLAN_COMPLETE]
  // injection so the agent's NEXT turn explicitly knows the plan is
  // done (and can summarize what was accomplished). Uses the same
  // pendingAgentInjection mechanism as the [PLAN_DECISION] /
  // [QUESTION_ANSWER] injections from sessions-patch.ts — single source
  // of truth across all channels. The agent prompt contract is "if
  // you see [PLAN_COMPLETE]: <title> — <N>/<M> steps, post a brief
  // summary of what was done and stop". Without this, the agent has
  // no signal that the plan auto-closed and may keep churning.
  const completionStepCount = params.snapshot.length;
  // Codex P2 review #68939 (round-2): build the [PLAN_COMPLETE]
  // text from the LOCKED auto-close decision (`appliedAllowAutoClose`
  // computed below), not the preflight `allowAutoClose`. If
  // preflight=deny but locked=allow, the close happens but the
  // injection was previously undefined — agent never sees the
  // [PLAN_COMPLETE] signal. Computed AFTER `updateSessionStore`
  // returns so we know the actual close outcome.
  let completionInjection: string | undefined;

  // Codex P1 review #68939 (post-nuclear-fix-stack round-1):
  // capture the locked auto-close decision OUT of the callback so
  // the post-write side effects (clearInPlanModeForSession +
  // [PLAN_COMPLETE] injection) use the SAME boolean as the actual
  // write. Pre-fix, the post-write branch keyed off the stale
  // preflight `allowAutoClose`, so under contention the in-memory
  // state could clear / `[PLAN_COMPLETE]` could enqueue without
  // planMode being closed (or skip when it was) — inconsistent
  // gating/notification across concurrent plan cycles.
  let appliedAllowAutoClose = allowAutoClose;
  await updateSessionStore(target.storePath, async (store) => {
    // Codex P1 review #68939 (post-nuclear-fix-stack):
    // re-evaluate `allowAutoClose` INSIDE the write lock against
    // the locked store snapshot. Pre-fix, the predicate was
    // computed from a separate read-only fetch BEFORE this
    // callback fires, so a concurrent write that started a new
    // plan cycle (or set approval pending) between the preflight
    // read and this write could close the newer cycle on the
    // stale boolean — reopening mutation tools without that
    // cycle's approval. Re-checking inside the lock makes the
    // decision atomic with the write.
    let lockedAllowAutoClose = allowAutoClose;
    if (params.closeOnComplete) {
      const lockedEntry = store[params.sessionKey] as Record<string, unknown> | undefined;
      const lockedPlanMode = lockedEntry?.planMode as Record<string, unknown> | undefined;
      const lockedApproval = lockedPlanMode?.approval;
      const lockedCycleId =
        typeof lockedPlanMode?.cycleId === "string" ? lockedPlanMode.cycleId : undefined;
      const lockedRecentlyApprovedAt = lockedEntry?.recentlyApprovedAt;
      const lockedRecentlyApprovedCycleId =
        typeof lockedEntry?.recentlyApprovedCycleId === "string"
          ? lockedEntry.recentlyApprovedCycleId
          : undefined;
      const lockedIsRecentlyApproved =
        typeof lockedRecentlyApprovedAt === "number" &&
        Date.now() - lockedRecentlyApprovedAt < 5 * 60_000;
      // Mirror the same predicate as the preflight read above so
      // both paths reach the same answer when state hasn't drifted,
      // but if state HAS drifted the locked snapshot wins.
      if (lockedApproval === "pending") {
        lockedAllowAutoClose = false;
      } else if (lockedApproval === "approved" || lockedApproval === "edited") {
        lockedAllowAutoClose = true;
      } else if (
        lockedApproval === undefined &&
        lockedIsRecentlyApproved &&
        lockedRecentlyApprovedCycleId &&
        !lockedCycleId
      ) {
        lockedAllowAutoClose = true;
      } else {
        lockedAllowAutoClose = false;
      }
      if (lockedAllowAutoClose !== allowAutoClose) {
        log.warn(
          `auto-close decision flipped under store lock: ` +
            `preflight=${allowAutoClose ? "allow" : "deny"} ` +
            `locked=${lockedAllowAutoClose ? "allow" : "deny"} ` +
            `lockedApproval=${String(lockedApproval)} sessionKey=${params.sessionKey} ` +
            `(state drift between preflight read + write lock — locked snapshot wins)`,
        );
      }
    }
    // Surface the locked decision to the post-write branch.
    appliedAllowAutoClose = lockedAllowAutoClose;
    // Codex P2 review #68939 (round-2): now that `appliedAllowAutoClose`
    // reflects the locked decision, build the [PLAN_COMPLETE]
    // injection text from it. Used downstream by the post-write
    // injection enqueue.
    if (params.closeOnComplete && lockedAllowAutoClose) {
      completionInjection = `[PLAN_COMPLETE]: ${completionStepCount} step${
        completionStepCount === 1 ? "" : "s"
      } completed. Post a brief summary of what was done and stop. The plan has been auto-closed; the user can start a new plan cycle if needed.`;
    }
    return await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: params.sessionKey,
      patch: {
        key: params.sessionKey,
        // Copilot review #68939 (2026-04-19): the wire schema for
        // `lastPlanSteps[].status` was tightened from
        // NonEmptyString to a closed enum (pending/in_progress/
        // completed/cancelled). The persister's snapshot can in
        // principle carry an unrecognized status (e.g., legacy
        // serialized data) — narrow with a type guard at the
        // boundary so a corrupted snapshot doesn't propagate
        // schema-violating writes downstream.
        lastPlanSteps: params.snapshot.map((s) => ({
          step: s.step,
          status: ((): "pending" | "in_progress" | "completed" | "cancelled" => {
            switch (s.status) {
              case "pending":
              case "in_progress":
              case "completed":
              case "cancelled":
                return s.status;
              default:
                // Map unrecognized/legacy status values to
                // "cancelled" so the close-on-complete logic
                // doesn't false-positive on them, but still
                // surfaces them in the rendered plan.
                return "cancelled";
            }
          })(),
          ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
          // PR-9 Wave B1 — forward closure-gate fields through.
          ...(s.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: s.acceptanceCriteria }
            : {}),
          ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
        })),
        ...(params.closeOnComplete && lockedAllowAutoClose ? { planMode: "normal" as const } : {}),
      },
    });
  });
  if (params.closeOnComplete && appliedAllowAutoClose) {
    // PR-9 Wave A2: mirror the session-state flip into in-memory run
    // context so concurrent / subsequent `sessions_spawn` calls in this
    // session see the cleared state immediately (no session-store
    // re-read on the spawn hot path).
    clearInPlanModeForSession(params.sessionKey);
    log.info(`plan completed → planMode auto-flipped to normal: sessionKey=${params.sessionKey}`);
    // Bug 6: write the [PLAN_COMPLETE] injection. Server-internal
    // direct write — the runtime's `consumePendingAgentInjection`
    // (PR-15 consumer) reads + clears it on the next agent turn.
    // Capture into a const so the inner async closure preserves
    // the string narrowing across the await (TS can't narrow `let`
    // across closure boundaries).
    const completionInjectionText = completionInjection;
    if (completionInjectionText) {
      try {
        const { updateSessionStoreEntry } = await import("../config/sessions/store.js");
        const { appendToInjectionQueue } = await import("../agents/plan-mode/injections.js");
        await updateSessionStoreEntry({
          storePath: target.storePath,
          sessionKey: params.sessionKey,
          update: async (entry) => {
            // Enqueue [PLAN_COMPLETE] into the typed injection queue.
            // Priority defaults to 9 (just below plan_decision=10) so a
            // concurrently-queued approval decision still drains first.
            // Dedup id is scoped to the session+timestamp so repeat
            // auto-close events (rare — the allowAutoClose gate above
            // prevents double-fire on the happy path) upsert rather
            // than duplicate.
            appendToInjectionQueue(entry, {
              id: `plan-complete-${params.sessionKey}-${Date.now()}`,
              kind: "plan_complete",
              text: completionInjectionText,
              createdAt: Date.now(),
            });
            // Plan lifecycle is ending — clear any acceptEdits
            // permission granted by this cycle's approval. The next
            // plan cycle will regenerate approvalId and set its own
            // permission (or not).
            if (entry.postApprovalPermissions !== undefined) {
              entry.postApprovalPermissions = undefined;
            }
            return entry;
          },
        });
      } catch (err) {
        log.warn(
          `[PLAN_COMPLETE] injection write failed: sessionKey=${params.sessionKey} err=${String(err)}`,
        );
      }
    }
  } else if (params.closeOnComplete && !allowAutoClose) {
    log.info(
      `plan completed but auto-close suppressed (no approved state): sessionKey=${params.sessionKey} — ` +
        "agent must call exit_plan_mode for explicit user approval before mutations unlock",
    );
  }
  params.emitSessionsChanged?.({ sessionKey: params.sessionKey, reason: "patch" });
}
