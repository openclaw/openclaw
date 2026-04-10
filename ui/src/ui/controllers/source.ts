import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  TaskFlowDetail,
  TaskRunAggregateSummary,
  TaskRunDetail,
  TaskRunView,
  TasksFlowsListResult,
  TasksListResult,
  TasksShowResult,
} from "../types.ts";

const EMPTY_TASK_SUMMARY: TaskRunAggregateSummary = {
  total: 0,
  active: 0,
  terminal: 0,
  failures: 0,
  byStatus: {
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    timed_out: 0,
    cancelled: 0,
    lost: 0,
  },
  byRuntime: {
    subagent: 0,
    acp: 0,
    cli: 0,
    cron: 0,
  },
};

export type SourceState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  sourceLoading: boolean;
  sourceError: string | null;
  sourceTasks: TaskRunView[];
  sourceTaskSummary: TaskRunAggregateSummary;
  sourceFlows: TaskFlowDetail[];
  sourceSelectedTaskId: string | null;
  sourceSelectedTask: TaskRunDetail | null;
  sourceSelectedTaskLoading: boolean;
};

export async function loadSource(state: SourceState): Promise<void> {
  if (!state.client || !state.connected || state.sourceLoading) {
    return;
  }
  state.sourceLoading = true;
  state.sourceError = null;
  try {
    const [tasksResult, flowsResult] = await Promise.all([
      state.client.request<TasksListResult>("tasks.list", {}),
      state.client.request<TasksFlowsListResult>("tasks.flows.list", {}),
    ]);
    state.sourceTasks = tasksResult?.tasks ?? [];
    state.sourceTaskSummary = tasksResult?.summary ?? { ...EMPTY_TASK_SUMMARY };
    state.sourceFlows = flowsResult?.flows ?? [];

    if (
      state.sourceSelectedTaskId &&
      !state.sourceTasks.some((task) => task.id === state.sourceSelectedTaskId)
    ) {
      state.sourceSelectedTaskId = null;
      state.sourceSelectedTask = null;
    }
  } catch (error) {
    state.sourceError = String(error);
  } finally {
    state.sourceLoading = false;
  }
}

export async function loadSourceTaskDetail(state: SourceState, taskId: string): Promise<void> {
  if (!state.client || !state.connected || state.sourceSelectedTaskLoading) {
    return;
  }
  state.sourceSelectedTaskId = taskId;
  state.sourceSelectedTaskLoading = true;
  state.sourceError = null;
  try {
    const result = await state.client.request<TasksShowResult>("tasks.show", { id: taskId });
    state.sourceSelectedTask = result?.task ?? null;
  } catch (error) {
    state.sourceError = String(error);
    state.sourceSelectedTask = null;
  } finally {
    state.sourceSelectedTaskLoading = false;
  }
}

export function clearSourceTaskSelection(state: SourceState): void {
  state.sourceSelectedTaskId = null;
  state.sourceSelectedTask = null;
  state.sourceSelectedTaskLoading = false;
}
