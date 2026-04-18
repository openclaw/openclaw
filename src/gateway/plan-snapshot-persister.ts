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
import { loadConfig } from "../config/io.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import { updateSessionStore } from "../config/sessions/store.js";
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
  return unsubscribe;
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
