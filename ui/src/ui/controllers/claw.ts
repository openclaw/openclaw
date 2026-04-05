import type {
  ClawControlState,
  ClawInboxItem,
  ClawMissionDashboard,
  ClawMissionDetail,
  ClawMissionDetailSnapshot,
  ClawMissionSummary,
} from "../../../../src/shared/claw-types.js";
import type { GatewayBrowserClient } from "../gateway.ts";

export type ClawState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  clawLoading: boolean;
  clawError: string | null;
  clawMissions: ClawMissionSummary[];
  clawSelectedMissionId: string | null;
  clawMission: ClawMissionDetail | null;
  clawGoalDraft: string;
  clawCreateBusy: boolean;
  clawActionBusy: boolean;
  clawControl: ClawControlState | null;
  clawInbox: ClawInboxItem[];
};

function applyDashboard(state: ClawState, dashboard: ClawMissionDashboard): void {
  state.clawMissions = dashboard.missions;
  state.clawControl = dashboard.control;
  state.clawInbox = dashboard.inbox;
  if (!state.clawSelectedMissionId && dashboard.missions[0]) {
    state.clawSelectedMissionId = dashboard.missions[0].id;
  }
}

function applySnapshot(state: ClawState, snapshot: ClawMissionDetailSnapshot): void {
  applyDashboard(state, snapshot);
  state.clawMission = snapshot.mission;
  if (snapshot.mission?.id) {
    state.clawSelectedMissionId = snapshot.mission.id;
  }
}

export async function loadClawDashboard(state: ClawState) {
  if (!state.client || !state.connected || state.clawLoading) {
    return;
  }
  state.clawLoading = true;
  state.clawError = null;
  try {
    const dashboard = await state.client.request<ClawMissionDashboard>("claw.missions.list", {});
    applyDashboard(state, dashboard);
    if (state.clawSelectedMissionId) {
      const snapshot = await state.client.request<ClawMissionDetailSnapshot>("claw.missions.get", {
        missionId: state.clawSelectedMissionId,
      });
      applySnapshot(state, snapshot);
    } else {
      state.clawMission = null;
    }
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawLoading = false;
  }
}

export async function selectClawMission(state: ClawState, missionId: string) {
  if (!state.client || !state.connected || !missionId.trim()) {
    return;
  }
  state.clawLoading = true;
  state.clawError = null;
  state.clawSelectedMissionId = missionId;
  try {
    const snapshot = await state.client.request<ClawMissionDetailSnapshot>("claw.missions.get", {
      missionId,
    });
    applySnapshot(state, snapshot);
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawLoading = false;
  }
}

export async function createClawMission(state: ClawState) {
  if (!state.client || !state.connected || !state.clawGoalDraft.trim() || state.clawCreateBusy) {
    return;
  }
  state.clawCreateBusy = true;
  state.clawError = null;
  try {
    const snapshot = await state.client.request<ClawMissionDetailSnapshot>("claw.missions.create", {
      goal: state.clawGoalDraft.trim(),
    });
    applySnapshot(state, snapshot);
    state.clawGoalDraft = "";
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawCreateBusy = false;
  }
}

async function mutateMission(
  state: ClawState,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!state.client || !state.connected || state.clawActionBusy) {
    return;
  }
  state.clawActionBusy = true;
  state.clawError = null;
  try {
    const snapshot = await state.client.request<ClawMissionDetailSnapshot>(method, params);
    applySnapshot(state, snapshot);
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawActionBusy = false;
  }
}

export async function approveClawMission(state: ClawState, missionId: string) {
  await mutateMission(state, "claw.missions.approveStart", { missionId });
}

export async function pauseClawMission(state: ClawState, missionId: string) {
  await mutateMission(state, "claw.missions.pause", { missionId });
}

export async function resumeClawMission(state: ClawState, missionId: string) {
  await mutateMission(state, "claw.missions.resume", { missionId });
}

export async function cancelClawMission(state: ClawState, missionId: string) {
  await mutateMission(state, "claw.missions.cancel", { missionId });
}

export async function rerunClawPreflight(state: ClawState, missionId: string) {
  await mutateMission(state, "claw.preflight.rerun", { missionId });
}

async function mutateControl(
  state: ClawState,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!state.client || !state.connected || state.clawActionBusy) {
    return;
  }
  state.clawActionBusy = true;
  state.clawError = null;
  try {
    const result = await state.client.request<{ control: ClawControlState }>(method, params);
    state.clawControl = result.control;
    await loadClawDashboard(state);
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawActionBusy = false;
  }
}

export async function pauseAllClaw(state: ClawState) {
  await mutateControl(state, "claw.control.pauseAll", {
    enabled: !(state.clawControl?.pauseAll ?? false),
  });
}

export async function stopAllClawNow(state: ClawState) {
  await mutateControl(state, "claw.control.stopAllNow", {});
}

export async function setClawAutonomy(state: ClawState, enabled: boolean) {
  await mutateControl(state, "claw.control.setAutonomy", { enabled });
}
