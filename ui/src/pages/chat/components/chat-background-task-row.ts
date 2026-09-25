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

type TaskDisplayFacts = {
  active: boolean;
  finishedDuration?: string;
  startedMs: number;
  timestamp: number;
  title: string;
  toolUseCount: number;
};

function taskDisplayFacts(task: TaskSummary): TaskDisplayFacts {
  const active = isActiveTask(task);
  const startedMs = taskTimestampMs(task.startedAt ?? task.createdAt);
  return {
    active,
    finishedDuration: taskFinishedDuration(task),
    startedMs,
    timestamp: taskTimestampMs(task.updatedAt ?? task.createdAt),
    title: taskTitle(task),
    toolUseCount: task.toolUseCount ?? 0,
  };
}

function renderTaskMeta(task: TaskSummary, facts: TaskDisplayFacts): TemplateResult {
  const tone = STATUS_TONES[task.status];
  return html`
    <div class="chat-tasks-rail__task-meta">
      <span class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${tone}"
        >${backgroundTaskStatusLabel(task)}</span
      >
      <span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
      <span>${taskRuntimeLabel(task)}</span>
      ${
        facts.active && facts.startedMs > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span
                ><openclaw-elapsed-time .startMs=${facts.startedMs}></openclaw-elapsed-time
              ></span>`
          : nothing
      }
      ${
        facts.finishedDuration
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span>${facts.finishedDuration}</span>`
          : nothing
      }
      ${
        !facts.active && facts.timestamp > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span title=${formatMs(facts.timestamp)}
                >${formatRelativeTimestamp(facts.timestamp)}</span
              >`
          : nothing
      }
      ${
        facts.toolUseCount > 0
          ? html`<span class="chat-tasks-rail__task-sep" aria-hidden="true">·</span>
              <span
                >${
                  facts.toolUseCount === 1
                    ? t("chat.backgroundTasks.toolUseOne")
                    : t("chat.backgroundTasks.toolUseMany", {
                        count: String(facts.toolUseCount),
                      })
                }</span
              >`
          : nothing
      }
      ${
        facts.active && (task.execution?.currentTool || task.lastToolName)
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
  const facts = taskDisplayFacts(task);
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
          <openclaw-tooltip .content=${facts.title}>
            <span class="chat-tasks-rail__task-title">${facts.title}</span>
          </openclaw-tooltip>
        </button>
        ${
          facts.active && props.canCancel
            ? html`
                <openclaw-tooltip
                  .content=${t("chat.backgroundTasks.stopTask", { title: facts.title })}
                >
                  <button
                    class="chat-tasks-rail__task-stop"
                    type="button"
                    aria-label=${t("chat.backgroundTasks.stopTask", { title: facts.title })}
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
      ${renderTaskMeta(task, facts)}
      ${delivery ? html`<div class="chat-tasks-rail__task-detail">${delivery}</div>` : nothing}
      ${detail ? html`<div class="chat-tasks-rail__task-detail">${detail}</div>` : nothing}
    </div>
  `;
}
