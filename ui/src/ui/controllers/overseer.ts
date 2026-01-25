import type { GatewayBrowserClient } from "../gateway";
import type {
  OverseerGoalStatusResult,
  OverseerStatusResult,
} from "../types/overseer";

export type OverseerState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  overseerLoading: boolean;
  overseerError: string | null;
  overseerStatus: OverseerStatusResult | null;
  overseerGoalLoading: boolean;
  overseerGoalError: string | null;
  overseerSelectedGoalId: string | null;
  overseerGoal: OverseerGoalStatusResult | null;
};

export async function loadOverseerStatus(
  state: OverseerState,
  opts?: { quiet?: boolean },
) {
  if (!state.client || !state.connected) return;
  if (state.overseerLoading) return;
  state.overseerLoading = true;
  if (!opts?.quiet) state.overseerError = null;
  try {
    const res = (await state.client.request("overseer.status", {
      includeGoals: true,
      includeAssignments: true,
    })) as OverseerStatusResult | undefined;
    if (res) state.overseerStatus = res;
  } catch (err) {
    if (!opts?.quiet) state.overseerError = String(err);
  } finally {
    state.overseerLoading = false;
  }
}

export async function loadOverseerGoal(
  state: OverseerState,
  goalId: string,
  opts?: { quiet?: boolean },
) {
  if (!state.client || !state.connected) return;
  if (state.overseerGoalLoading) return;
  state.overseerGoalLoading = true;
  if (!opts?.quiet) state.overseerGoalError = null;
  try {
    const res = (await state.client.request("overseer.goal.status", { goalId })) as
      | OverseerGoalStatusResult
      | undefined;
    if (res) state.overseerGoal = res;
  } catch (err) {
    if (!opts?.quiet) state.overseerGoalError = String(err);
  } finally {
    state.overseerGoalLoading = false;
  }
}

export async function refreshOverseer(
  state: OverseerState,
  opts?: { quiet?: boolean },
) {
  await loadOverseerStatus(state, opts);
  const goals = state.overseerStatus?.goals ?? [];
  if (goals.length === 0) {
    state.overseerSelectedGoalId = null;
    state.overseerGoal = null;
    return;
  }
  const selected =
    state.overseerSelectedGoalId && goals.some((goal) => goal.goalId === state.overseerSelectedGoalId)
      ? state.overseerSelectedGoalId
      : goals[0]?.goalId ?? null;
  state.overseerSelectedGoalId = selected;
  if (selected) {
    await loadOverseerGoal(state, selected, { quiet: true });
  } else {
    state.overseerGoal = null;
  }
}

export async function tickOverseer(state: OverseerState, reason?: string) {
  if (!state.client || !state.connected) return;
  try {
    await state.client.request("overseer.tick", { reason });
  } catch (err) {
    state.overseerError = String(err);
  }
}
