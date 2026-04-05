import type {
  ClawArtifactEntry,
  ClawAuditEntry,
  ClawControlState,
  ClawInboxItem,
  ClawDecisionAction,
  ClawMissionDashboard,
  ClawMissionDetail,
  ClawMissionDetailSnapshot,
  ClawMissionSummary,
} from "../../../../src/shared/claw-types.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfigSnapshot } from "../types.ts";

export type ClawState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  configSnapshot: ConfigSnapshot | null;
  configForm: Record<string, unknown> | null;
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
  clawAuditLoading: boolean;
  clawAuditEntries: ClawAuditEntry[];
  clawArtifactsLoading: boolean;
  clawArtifacts: ClawArtifactEntry[];
};

function isClawEnabled(state: Pick<ClawState, "configForm" | "configSnapshot">): boolean {
  const config =
    state.configForm ??
    ((state.configSnapshot?.config as Record<string, unknown> | null | undefined) ?? null);
  const claw = config?.claw;
  return Boolean(claw && typeof claw === "object" && (claw as { enabled?: unknown }).enabled === true);
}

function clearClawState(state: ClawState): void {
  state.clawError = null;
  state.clawMissions = [];
  state.clawSelectedMissionId = null;
  state.clawMission = null;
  state.clawControl = null;
  state.clawInbox = [];
  state.clawAuditEntries = [];
  state.clawArtifacts = [];
}

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

async function loadClawMissionOutputs(state: ClawState, missionId: string): Promise<void> {
  if (!state.client || !state.connected || !missionId.trim()) {
    state.clawAuditEntries = [];
    state.clawArtifacts = [];
    return;
  }
  state.clawAuditLoading = true;
  state.clawArtifactsLoading = true;
  try {
    const [audit, artifacts] = await Promise.all([
      state.client.request<{ missionId: string; entries: ClawAuditEntry[] }>("claw.audit.get", {
        missionId,
        limit: 50,
      }),
      state.client.request<{ missionId: string; artifacts: ClawArtifactEntry[] }>(
        "claw.artifacts.list",
        {
          missionId,
        },
      ),
    ]);
    state.clawAuditEntries = audit.entries;
    state.clawArtifacts = artifacts.artifacts;
  } finally {
    state.clawAuditLoading = false;
    state.clawArtifactsLoading = false;
  }
}

export async function loadClawDashboard(state: ClawState) {
  if (!state.client || !state.connected || state.clawLoading) {
    return;
  }
  if (!isClawEnabled(state)) {
    clearClawState(state);
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
      await loadClawMissionOutputs(state, state.clawSelectedMissionId);
    } else {
      state.clawMission = null;
      state.clawAuditEntries = [];
      state.clawArtifacts = [];
    }
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawLoading = false;
  }
}

export async function selectClawMission(state: ClawState, missionId: string) {
  if (!state.client || !state.connected || !missionId.trim() || !isClawEnabled(state)) {
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
    await loadClawMissionOutputs(state, missionId);
  } catch (error) {
    state.clawError = String(error);
  } finally {
    state.clawLoading = false;
  }
}

export async function createClawMission(state: ClawState) {
  if (
    !state.client ||
    !state.connected ||
    !state.clawGoalDraft.trim() ||
    state.clawCreateBusy ||
    !isClawEnabled(state)
  ) {
    return;
  }
  state.clawCreateBusy = true;
  state.clawError = null;
  try {
    const snapshot = await state.client.request<ClawMissionDetailSnapshot>("claw.missions.create", {
      goal: state.clawGoalDraft.trim(),
    });
    applySnapshot(state, snapshot);
    if (snapshot.mission?.id) {
      await loadClawMissionOutputs(state, snapshot.mission.id);
    }
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
  if (!isClawEnabled(state)) {
    return;
  }
  state.clawActionBusy = true;
  state.clawError = null;
  try {
    const snapshot = await state.client.request<ClawMissionDetailSnapshot>(method, params);
    applySnapshot(state, snapshot);
    if (snapshot.mission?.id) {
      await loadClawMissionOutputs(state, snapshot.mission.id);
    } else {
      state.clawAuditEntries = [];
      state.clawArtifacts = [];
    }
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

export async function replyClawDecision(
  state: ClawState,
  missionId: string,
  decisionId: string,
  action: ClawDecisionAction,
) {
  await mutateMission(state, "claw.decisions.reply", {
    missionId,
    decisionId,
    action,
  });
}

async function mutateControl(
  state: ClawState,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (!state.client || !state.connected || state.clawActionBusy) {
    return;
  }
  if (!isClawEnabled(state)) {
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
