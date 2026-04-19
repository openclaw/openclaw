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
    const isPlanSubmission =
      (phase === "requested" || phase === "request") &&
      kind === "plugin" &&
      title !== undefined &&
      title.length > 0 &&
      Array.isArray(data.plan);
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
    const recentlyApprovedAt = existing?.recentlyApprovedAt;
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
    if (approval === "pending") {
      allowAutoClose = false;
    } else if (approval === "approved" || approval === "edited") {
      // Explicit approval signal — close is the right next step.
      allowAutoClose = true;
    } else if (approval !== "rejected" && isRecentlyApproved) {
      // Post-approval grace window (planMode may already be deleted
      // from a prior close; recentlyApprovedAt survives at root).
      // Skip when current approval is "rejected" — user said no, do
      // not auto-close around them.
      allowAutoClose = true;
    } else {
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
  const completionInjection =
    params.closeOnComplete && allowAutoClose
      ? `[PLAN_COMPLETE]: ${completionStepCount} step${
          completionStepCount === 1 ? "" : "s"
        } completed. Post a brief summary of what was done and stop. The plan has been auto-closed; the user can start a new plan cycle if needed.`
      : undefined;

  await updateSessionStore(target.storePath, async (store) => {
    return await applySessionsPatchToStore({
      cfg,
      store,
      storeKey: params.sessionKey,
      patch: {
        key: params.sessionKey,
        lastPlanSteps: params.snapshot.map((s) => ({
          step: s.step,
          status: s.status,
          ...(s.activeForm !== undefined ? { activeForm: s.activeForm } : {}),
          // PR-9 Wave B1 — forward closure-gate fields through.
          ...(s.acceptanceCriteria !== undefined
            ? { acceptanceCriteria: s.acceptanceCriteria }
            : {}),
          ...(s.verifiedCriteria !== undefined ? { verifiedCriteria: s.verifiedCriteria } : {}),
        })),
        ...(params.closeOnComplete && allowAutoClose ? { planMode: "normal" as const } : {}),
      },
    });
  });
  if (params.closeOnComplete && allowAutoClose) {
    // PR-9 Wave A2: mirror the session-state flip into in-memory run
    // context so concurrent / subsequent `sessions_spawn` calls in this
    // session see the cleared state immediately (no session-store
    // re-read on the spawn hot path).
    clearInPlanModeForSession(params.sessionKey);
    log.info(`plan completed → planMode auto-flipped to normal: sessionKey=${params.sessionKey}`);
    // Bug 6: write the [PLAN_COMPLETE] injection. Server-internal
    // direct write — the runtime's `consumePendingAgentInjection`
    // (PR-15 consumer) reads + clears it on the next agent turn.
    if (completionInjection) {
      try {
        const { updateSessionStoreEntry } = await import("../config/sessions/store.js");
        await updateSessionStoreEntry({
          storePath: target.storePath,
          sessionKey: params.sessionKey,
          update: async (entry) => {
            // Don't clobber an existing pending injection (e.g.,
            // [QUESTION_ANSWER] or [PLAN_DECISION] from a recent
            // sessions.patch). Append instead so both signals land in
            // the agent's next turn.
            const existing = entry.pendingAgentInjection;
            entry.pendingAgentInjection = existing
              ? `${existing}\n\n${completionInjection}`
              : completionInjection;
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
