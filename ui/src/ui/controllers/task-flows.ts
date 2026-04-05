import type { GatewayBrowserClient } from "../gateway.ts";
import type { TaskFlowActionResult, TaskFlowDetail } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

export type TaskFlowState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sessionKey: string;
  taskFlowLoading: boolean;
  taskFlowActionBusy: boolean;
  taskFlowDetail: TaskFlowDetail | null;
  taskFlowError: string | null;
};

export async function loadLatestTaskFlow(state: TaskFlowState): Promise<void> {
  if (!state.client || !state.connected) {
    state.taskFlowDetail = null;
    return;
  }
  if (state.taskFlowLoading) {
    return;
  }
  state.taskFlowLoading = true;
  state.taskFlowError = null;
  try {
    const res = await state.client.request<{ flow?: TaskFlowDetail | null }>(
      "tasks.flows.findLatest",
      { sessionKey: state.sessionKey },
    );
    state.taskFlowDetail = res?.flow ?? null;
  } catch (err) {
    if (isMissingOperatorReadScopeError(err)) {
      state.taskFlowDetail = null;
      state.taskFlowError = formatMissingOperatorReadScopeMessage("task flows");
    } else {
      state.taskFlowError = String(err);
    }
  } finally {
    state.taskFlowLoading = false;
  }
}

async function runTaskFlowAction(
  state: TaskFlowState,
  method: "tasks.flows.retry" | "tasks.flows.cancel",
): Promise<TaskFlowActionResult | null> {
  if (!state.client || !state.connected || !state.taskFlowDetail || state.taskFlowActionBusy) {
    return null;
  }
  state.taskFlowActionBusy = true;
  state.taskFlowError = null;
  try {
    const result = await state.client.request<TaskFlowActionResult>(method, {
      sessionKey: state.sessionKey,
      flowId: state.taskFlowDetail.id,
    });
    if (result.flow !== undefined) {
      state.taskFlowDetail = result.flow ?? null;
    }
    if (
      result.reason &&
      (("retried" in result && !result.retried) || ("cancelled" in result && !result.cancelled))
    ) {
      state.taskFlowError = result.reason;
    }
    return result;
  } catch (err) {
    state.taskFlowError = String(err);
    return null;
  } finally {
    state.taskFlowActionBusy = false;
  }
}

export async function retryLatestTaskFlow(
  state: TaskFlowState,
): Promise<TaskFlowActionResult | null> {
  return runTaskFlowAction(state, "tasks.flows.retry");
}

export async function cancelLatestTaskFlow(
  state: TaskFlowState,
): Promise<TaskFlowActionResult | null> {
  return runTaskFlowAction(state, "tasks.flows.cancel");
}
