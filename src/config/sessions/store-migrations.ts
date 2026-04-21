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
    // before the 3-state widening landed. Detection requires ALL of:
    //   - existing `mode === "normal"`
    //   - non-empty `lastPlanSteps`
    //   - at least one step still pending or in_progress
    //   - `approval === "approved"` OR `approval === "edited"`
    //     (adversarial review #1 tightening: the approval check
    //     prevents false-positives for legacy sessions that entered
    //     plan mode, got rejected, and then hit /plan off — those
    //     sessions had non-empty lastPlanSteps with in_progress
    //     statuses from the pre-reject design work, but were never
    //     actually approved. Without this check, such sessions
    //     backfill to "executing" and misreport via plan_mode_status).
    //
    // Why backfill on read instead of a one-shot script: keeps the
    // upgrade path zero-touch for operators (gateway restart applies
    // it automatically on the next session-store load) and idempotent
    // (re-running on already-migrated entries is a no-op because
    // mode === "executing" doesn't match the "normal" guard).
    //
    // Safe failure mode: if we still get the heuristic wrong (e.g.
    // the operator deliberately had a planMode.normal entry with
    // stale lastPlanSteps + stale approval="approved" from a long-
    // completed plan), the only effect is the chip renders as
    // "Executing" until close-on-complete fires OR the user clicks
    // /plan off — no functional impact on mutations / nudges.
    const planModeRec = rec.planMode as Record<string, unknown> | undefined;
    if (
      planModeRec &&
      typeof planModeRec === "object" &&
      planModeRec.mode === "normal" &&
      Array.isArray(planModeRec.lastPlanSteps) &&
      planModeRec.lastPlanSteps.length > 0 &&
      (planModeRec.approval === "approved" || planModeRec.approval === "edited")
    ) {
      const hasInFlightStep = planModeRec.lastPlanSteps.some((s: unknown) => {
        if (!s || typeof s !== "object") {
          return false;
        }
        const status = (s as { status?: unknown }).status;
        return status === "pending" || status === "in_progress";
      });
      if (hasInFlightStep) {
        planModeRec.mode = "executing";
      }
    }
  }
}
