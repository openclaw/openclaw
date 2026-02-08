import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  MissionControlFormState,
  MissionControlTask,
  MissionControlTaskStatus,
} from "../views/mission-control.ts";

export type MissionControlState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  mcLoading: boolean;
  mcTasks: MissionControlTask[];
  mcError: string | null;
  mcForm: MissionControlFormState;
  mcDeleteConfirmId: string | null;
  mcAgentSpawnBusy: boolean;
};

export const DEFAULT_MC_FORM: MissionControlFormState = {
  title: "",
  description: "",
  priority: "0",
  tags: "",
};

export async function loadMissionControlTasks(state: MissionControlState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.mcLoading) {
    return;
  }
  state.mcLoading = true;
  state.mcError = null;
  try {
    const res = await state.client.request<{ tasks?: Array<MissionControlTask> }>(
      "missionControl.list",
      {},
    );
    state.mcTasks = Array.isArray(res.tasks) ? res.tasks : [];
  } catch (err) {
    state.mcError = String(err);
  } finally {
    state.mcLoading = false;
  }
}

export async function createMissionControlTask(state: MissionControlState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.mcLoading = true;
  state.mcError = null;
  try {
    const tags = state.mcForm.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const res = await state.client.request<{ task: MissionControlTask }>("missionControl.create", {
      title: state.mcForm.title.trim(),
      description: state.mcForm.description.trim(),
      priority: parseInt(state.mcForm.priority, 10) || 0,
      tags,
    });

    // Reset form
    state.mcForm = { ...DEFAULT_MC_FORM };

    // Reload tasks
    await loadMissionControlTasks(state);
  } catch (err) {
    state.mcError = String(err);
  } finally {
    state.mcLoading = false;
  }
}

export async function updateMissionControlTaskStatus(
  state: MissionControlState,
  taskId: string,
  status: MissionControlTaskStatus,
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.mcLoading = true;
  state.mcError = null;
  try {
    await state.client.request("missionControl.update", {
      id: taskId,
      patch: { status },
    });
    await loadMissionControlTasks(state);
  } catch (err) {
    state.mcError = String(err);
  } finally {
    state.mcLoading = false;
  }
}

export async function deleteMissionControlTask(state: MissionControlState, taskId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  state.mcLoading = true;
  state.mcError = null;
  try {
    await state.client.request("missionControl.delete", { id: taskId });
    state.mcDeleteConfirmId = null;
    await loadMissionControlTasks(state);
  } catch (err) {
    state.mcError = String(err);
  } finally {
    state.mcLoading = false;
  }
}

export async function spawnAgentForTask(
  state: MissionControlState,
  taskId: string,
  agentId?: string,
) {
  if (!state.client || !state.connected) {
    return;
  }
  state.mcAgentSpawnBusy = true;
  state.mcError = null;
  try {
    await state.client.request("missionControl.spawnAgent", {
      taskId,
      agentId: agentId || "default",
    });
    await loadMissionControlTasks(state);
  } catch (err) {
    state.mcError = String(err);
  } finally {
    state.mcAgentSpawnBusy = false;
  }
}
