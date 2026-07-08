// Application-owned goal chip state: parses `goal.updated` events into a single
// current-goal snapshot the persistent "Pursuing goal" chip renders from.
//
// Unlike the question queue there is at most one goal per session; the Control UI
// tracks the goal for whichever session it broadcasts about. A cleared or
// completed goal removes the chip.
import { normalizeOptionalString } from "../lib/string-coerce.ts";

/** Goal statuses mirrored from the gateway SessionGoalStatus union. */
export type GoalChipStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage_limited"
  | "budget_limited"
  | "complete";

export type GoalChipEntry = {
  sessionKey: string;
  status: GoalChipStatus;
  objective: string;
  tokensUsed: number | null;
  tokenBudget: number | null;
};

export type GoalChipState = {
  client: {
    request(method: string, params?: unknown): Promise<unknown>;
  } | null;
  /** The current goal to surface, or null when there is nothing to show. */
  goal: GoalChipEntry | null;
  busy: boolean;
  error: string | null;
};

const CHIP_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
]);

/** A cleared or completed goal is not surfaced as a chip. */
const HIDDEN_STATUSES: ReadonlySet<GoalChipStatus> = new Set(["complete"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Parses a `goal.updated` event payload into a chip entry, or null when the goal
 * was cleared/completed (chip removed) or the payload is malformed.
 */
export function parseGoalUpdated(payload: unknown): GoalChipEntry | null {
  if (!isRecord(payload)) {
    return null;
  }
  const sessionKey = normalizeOptionalString(payload.sessionKey);
  if (!sessionKey) {
    return null;
  }
  const status = typeof payload.status === "string" ? payload.status : null;
  const objective = normalizeOptionalString(payload.objective);
  // A cleared goal arrives as status:null / objective:null — remove the chip.
  if (!status || !objective || !CHIP_STATUSES.has(status)) {
    return null;
  }
  if (HIDDEN_STATUSES.has(status as GoalChipStatus)) {
    return null;
  }
  return {
    sessionKey,
    status: status as GoalChipStatus,
    objective,
    tokensUsed: parseCount(payload.tokensUsed),
    tokenBudget: parseCount(payload.tokenBudget),
  };
}

/**
 * Applies a `goal.updated` event to the chip state. A parseable active goal
 * becomes the current chip; a cleared/completed goal for the currently-shown
 * session removes it.
 */
export function applyGoalUpdated(state: GoalChipState, payload: unknown): void {
  const entry = parseGoalUpdated(payload);
  if (entry) {
    state.goal = entry;
    state.error = null;
    return;
  }
  // Not surfaced: if this event is for the currently-shown session, clear it.
  const sessionKey = isRecord(payload) ? normalizeOptionalString(payload.sessionKey) : null;
  if (state.goal && (!sessionKey || sessionKey === state.goal.sessionKey)) {
    state.goal = null;
    state.error = null;
  }
}

/** Clears the current goal chip (e.g. on disconnect). */
export function clearGoalChip(state: GoalChipState): void {
  state.goal = null;
  state.busy = false;
  state.error = null;
}
