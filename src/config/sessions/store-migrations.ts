import type { SessionEntry } from "./types.js";

export function applySessionStoreMigrations(store: Record<string, SessionEntry>): void {
  // Best-effort migration: message provider → channel naming.
  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const rec = entry as unknown as Record<string, unknown>;
    if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
      rec.channel = rec.provider;
      delete rec.provider;
    }
    if (typeof rec.lastChannel !== "string" && typeof rec.lastProvider === "string") {
      rec.lastChannel = rec.lastProvider;
      delete rec.lastProvider;
    }

    // Best-effort migration: legacy `room` field → `groupChannel` (keep value, prune old key).
    if (typeof rec.groupChannel !== "string" && typeof rec.room === "string") {
      rec.groupChannel = rec.room;
      delete rec.room;
    } else if ("room" in rec) {
      delete rec.room;
    }

    // PR #68939 follow-up — backfill `planMode.mode = "executing"` for
    // entries that were left in the post-approval execution phase
    // before the 3-state widening landed. Detection: existing
    // `mode === "normal"` AND `lastPlanSteps` contains at least one
    // step that's still pending or in_progress (i.e. the close-on-
    // complete detector hasn't fired yet, so the plan is genuinely
    // mid-execution despite the legacy 2-state model collapsing it
    // to "normal").
    //
    // Why backfill on read instead of a one-shot script: keeps the
    // upgrade path zero-touch for operators (gateway restart applies
    // it automatically on the next session-store load) and idempotent
    // (re-running on already-migrated entries is a no-op because
    // mode === "executing" doesn't match the "normal" guard).
    //
    // Safe failure mode: if we get the heuristic wrong (e.g. the
    // operator deliberately had a planMode.normal entry with stale
    // lastPlanSteps from a long-completed plan), the only effect is
    // the chip renders as "Executing" until close-on-complete fires
    // OR the user clicks /plan off — no functional impact on
    // mutations / approval / nudges.
    const planModeRec = rec.planMode as Record<string, unknown> | undefined;
    if (
      planModeRec &&
      typeof planModeRec === "object" &&
      planModeRec.mode === "normal" &&
      Array.isArray(planModeRec.lastPlanSteps) &&
      planModeRec.lastPlanSteps.length > 0
    ) {
      const hasInFlightStep = planModeRec.lastPlanSteps.some((s: unknown) => {
        if (!s || typeof s !== "object") return false;
        const status = (s as { status?: unknown }).status;
        return status === "pending" || status === "in_progress";
      });
      if (hasInFlightStep) {
        planModeRec.mode = "executing";
      }
    }
  }
}
