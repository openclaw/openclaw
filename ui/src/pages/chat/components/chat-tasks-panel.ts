import { nothing } from "lit";
import { renderBackgroundTasksRail } from "./chat-background-tasks-render.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import type { TaskDetailHost } from "./chat-task-detail-state.ts";
import { renderTaskDetailPanel } from "./chat-task-detail.ts";

export function renderChatTasksPanel(params: {
  backgroundTasks: BackgroundTasksProps;
  host: TaskDetailHost;
  presented?: boolean;
  loadFullAssistantMessage?: SidebarFullMessageLoader | null;
}) {
  // Pane retirement stops transcript requests without deleting saved intent.
  // Switching side-panel tabs is not retirement: hidden Tasks stays mounted.
  if (params.presented === false) {
    return nothing;
  }
  const { backgroundTasks } = params;
  const taskId = backgroundTasks.selectedTaskId;
  return taskId
    ? renderTaskDetailPanel({
        ...params,
        task:
          backgroundTasks.tasks?.find((task) => task.id === taskId) ??
          backgroundTasks.taskDetails.get(taskId),
        taskId,
        onBack: backgroundTasks.onOpenTaskList,
      })
    : renderBackgroundTasksRail(backgroundTasks, { embedded: true });
}
