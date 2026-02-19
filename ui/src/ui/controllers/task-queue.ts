import type { GatewayBrowserClient } from "../gateway.ts";
import type { TaskQueueSnapshot } from "../types.ts";

export type TaskQueueState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  taskQueueLoading: boolean;
  taskQueueSnapshot: TaskQueueSnapshot | null;
  taskQueueError: string | null;
};

export async function loadTaskQueue(state: TaskQueueState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.taskQueueLoading) {
    return;
  }
  state.taskQueueLoading = true;
  state.taskQueueError = null;
  try {
    const snapshot = await state.client.request("taskQueue.list", {});
    state.taskQueueSnapshot = snapshot as TaskQueueSnapshot;
  } catch (err) {
    state.taskQueueError = String(err);
  } finally {
    state.taskQueueLoading = false;
  }
}
