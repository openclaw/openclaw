import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { formatMs, formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  isActiveTask,
  taskDetail,
  taskFinishedDuration,
  taskRuntimeLabel,
  taskTimestampMs,
  taskTitle,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  backgroundTaskDeliveryLabel,
  backgroundTaskIsExecuting,
  backgroundTaskStatusLabel,
  STATUS_TONES,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";

registerBackgroundTasksEnglish();

function renderTaskMeta(task: TaskSummary, active: boolean): TemplateResult {
  const startedMs = taskTimestampMs(task.startedAt ?? task.createdAt);
  const finishedDuration = taskFinishedDuration(task);
  const timestamp = taskTimestampMs(task.updatedAt ?? task.createdAt);
  const toolUseCount = task.toolUseCount ?? 0;
  const tone = STATUS_TONES[task.status];
  return html`
    <div class="chat-tasks-rail__task-meta">
      <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
        >${backgroundTaskStatusLabel(task)}</span
      >
      <span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
      <span>${taskRuntimeLabel(task)}</span>
      ${
        active && startedMs > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span><openclaw-elapsed-time .startMs=${startedMs}></openclaw-elapsed-time></span>`
          : nothing
      }
      ${
        finishedDuration
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span>${finishedDuration}</span>`
          : nothing
      }
      ${
        !active && timestamp > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span title=${formatMs(timestamp)}>${formatRelativeTimestamp(timestamp)}</span>`
          : nothing
      }
      ${
        toolUseCount > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span
                >${
                  toolUseCount === 1
                    ? t("chat.backgroundTasks.toolUseOne")
                    : t("chat.backgroundTasks.toolUseMany", {
                        count: String(toolUseCount),
                      })
                }</span
              >`
          : nothing
      }
      ${
        active && (task.execution?.currentTool || task.lastToolName)
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span class="chat-tasks-rail__task-tool"
                >${t(task.execution?.currentTool ? "chat.backgroundTasks.currentTool" : "chat.backgroundTasks.lastTool")}:
                ${task.execution?.currentTool?.name ?? task.lastToolName}</span
              >`
          : nothing
      }
    </div>
  `;
}

export function renderTaskRow(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
  const title = taskTitle(task);
  const active = isActiveTask(task);
  const detail = taskDetail(task);
  const delivery = backgroundTaskDeliveryLabel(task);
  const cancelling = props.cancellingTaskIds.has(task.id);
  return html`
    <div
      class="chat-tasks-rail__task"
      role="listitem"
      data-task-id=${task.id}
      @click=${(event: MouseEvent) => {
        const target = event.target;
        if (target instanceof Element && target.closest("button, a")) {
          return;
        }
        props.onOpenTaskDetail?.(task);
      }}
    >
      <div class="chat-tasks-rail__task-head">
        <button
          class="chat-tasks-rail__task-open"
          type="button"
          @click=${() => props.onOpenTaskDetail?.(task)}
        >
          ${
            backgroundTaskIsExecuting(task)
              ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
              : nothing
          }
          <openclaw-tooltip .content=${title}>
            <span class="chat-tasks-rail__task-title">${title}</span>
          </openclaw-tooltip>
        </button>
        ${
          active && props.canCancel
            ? html`
                <openclaw-tooltip .content=${t("chat.backgroundTasks.stopTask", { title })}>
                  <button
                    class="chat-tasks-rail__task-stop"
                    type="button"
                    aria-label=${t("chat.backgroundTasks.stopTask", { title })}
                    ?disabled=${cancelling || !props.connected}
                    @click=${(event: MouseEvent) => {
                      event.stopPropagation();
                      props.onCancel(task.id);
                    }}
                  >
                    ${cancelling ? icons.loader : icons.stop}
                  </button>
                </openclaw-tooltip>
              `
            : nothing
        }
      </div>
      ${renderTaskMeta(task, active)}
      ${delivery ? html`<div class="chat-tasks-rail__task-detail">${delivery}</div>` : nothing}
      ${detail ? html`<div class="chat-tasks-rail__task-detail">${detail}</div>` : nothing}
    </div>
  `;
}
