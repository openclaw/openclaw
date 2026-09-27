import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type TemplateResult } from "lit";
import "../../../components/elapsed-time.ts";
import { ref } from "lit/directives/ref.js";
import { icons } from "../../../components/icons.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { uiConversationMatches } from "../../../lib/sessions/session-key.ts";
import {
  isActiveTask,
  newestTaskSnapshot,
  taskDetail,
  taskRuntimeLabel,
  taskTimestampMs,
  taskDisplayTitle,
  taskFinishedDuration,
} from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import { renderBackgroundTasksError } from "./chat-background-tasks-render.ts";
import {
  backgroundTaskStatusLabel,
  backgroundTaskIsExecuting,
  backgroundTaskDeliveryLabel,
  STATUS_TONES,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { renderDiffStatChips } from "./chat-diff-render.ts";
import { renderChatHistoryBoundary } from "./chat-history-boundary.ts";
import type { SidebarFullMessageLoader } from "./chat-sidebar-content-types.ts";
import {
  loadOlderTaskTranscript,
  readTaskTranscript,
  requestTaskFullMessage,
  resetTaskDetail,
  retryTaskTranscript,
  type TaskDetailHost,
  type TaskTranscriptHost,
} from "./chat-task-detail-state.ts";
import { renderChatTranscriptFeed } from "./chat-transcript-feed.ts";

registerBackgroundTasksEnglish();

export function renderTaskDetailPanel(params: {
  backgroundTasks: BackgroundTasksProps;
  host: TaskDetailHost;
  task: TaskSummary | undefined;
  taskId?: string;
  loadFullAssistantMessage?: SidebarFullMessageLoader | null;
  onBack?: () => void;
}): TemplateResult {
  const { backgroundTasks, task, taskId } = params;
  if (!task) {
    resetTaskDetail(params.host);
    const error = taskId ? backgroundTasks.taskDetailErrors.get(taskId) : undefined;
    const loading =
      !error &&
      (backgroundTasks.loading ||
        (backgroundTasks.connected && backgroundTasks.tasks === null && !backgroundTasks.error) ||
        (taskId && backgroundTasks.taskDetailLoadingIds.has(taskId)));
    return html`
      <div class="sidebar-panel chat-task-detail" data-task-detail-panel>
        ${renderTaskHeader(t("chat.backgroundTasks.taskDetailTitle"), undefined, undefined, params.onBack)}
        ${renderBackgroundTasksError(backgroundTasks.error)}
        ${
          loading
            ? renderPanelLoadingSkeleton("tasks", t("chat.backgroundTasks.detailLoading"))
            : html`<div class="sidebar-content chat-task-detail__state">
                ${error ?? backgroundTasks.error ?? t("chat.backgroundTasks.taskUnavailable")}
                ${error && taskId && backgroundTasks.onLoadDetail ? html`<button type="button" @click=${() => backgroundTasks.onLoadDetail?.({ id: taskId })}>${t("chat.backgroundTasks.detailRetry")}</button>` : nothing}
              </div>`
        }
      </div>
    `;
  }
  const detailedTask = backgroundTasks.taskDetails.get(task.id);
  const currentTask = newestTaskSnapshot(task, detailedTask);
  if (currentTask.title == null && currentTask.kind == null && !detailedTask?.prompt) {
    loadTaskDetail(currentTask, backgroundTasks);
  }
  // A subagent's sessionKey names its requester. Only a child session can supply
  // session metadata; harness-owned transcripts are addressed by task ID.
  const transcriptSessionKey = normalizeOptionalString(
    currentTask.runtime === "subagent"
      ? currentTask.childSessionKey
      : (currentTask.childSessionKey ?? currentTask.sessionKey),
  );
  // Preserve child-session previews while allowing the task owner to advertise
  // transcript history without creating an OpenClaw session.
  const hasTranscript = transcriptSessionKey
    ? !uiConversationMatches(
        params.host,
        params.host.sessionKey,
        transcriptSessionKey,
        currentTask.agentId,
      )
    : currentTask.hasTranscript === true;
  const content = hasTranscript
    ? renderTaskTranscript({
        host: params.host,
        task: currentTask,
        transcriptSessionKey,
        loadFullAssistantMessage: params.loadFullAssistantMessage,
      })
    : renderTaskFallback(currentTask, backgroundTasks, params.host);
  return html`
    <div class="sidebar-panel chat-task-detail" data-task-detail-panel>
      ${renderTaskHeader(taskDisplayTitle(currentTask, detailedTask), currentTask, backgroundTasks, params.onBack)}
      ${renderBackgroundTasksError(backgroundTasks.error)}
      ${renderTaskObservation(currentTask, backgroundTasks)} ${content}
    </div>
  `;
}

// The shared panel header owns closing; this action returns to the task list.
function renderTaskHeader(
  title: string,
  task?: TaskSummary,
  backgroundTasks?: BackgroundTasksProps,
  onBack?: () => void,
): TemplateResult {
  const active = task ? isActiveTask(task) : false;
  const startedMs = task ? taskTimestampMs(task.startedAt ?? task.createdAt) : 0;
  const duration = task ? taskFinishedDuration(task) : undefined;
  const cancelling = task ? backgroundTasks?.cancellingTaskIds.has(task.id) === true : false;
  return html`
    <div class="sidebar-header chat-task-detail__header">
      <div class="chat-task-detail__heading">
        ${onBack ? html`<button class="btn btn--ghost btn--sm" type="button" @click=${onBack}>${icons.arrowLeft} ${t("chat.backgroundTasks.backToTasks")}</button>` : nothing}
        <div class="sidebar-title" title=${title}>${title}</div>
        ${
          task
            ? html`<div class="chat-task-detail__meta">
                ${
                  backgroundTaskIsExecuting(task)
                    ? html`<span class="chat-tasks-rail__task-pulse" aria-hidden="true"></span>`
                    : nothing
                }
                <span
                  class="chat-tasks-rail__task-status chat-tasks-rail__task-status--${
                    STATUS_TONES[task.status]
                  }"
                  >${backgroundTaskStatusLabel(task)}</span
                >
                ${active && startedMs > 0 ? html`<span aria-hidden="true">·</span><openclaw-elapsed-time .startMs=${startedMs}></openclaw-elapsed-time>` : duration ? html`<span aria-hidden="true">·</span><span>${duration}</span>` : nothing}
                ${(task.toolUseCount ?? 0) > 0 ? html`<span aria-hidden="true">·</span><span>${t(task.toolUseCount === 1 ? "chat.backgroundTasks.toolCallsOne" : "chat.backgroundTasks.toolCallsMany", { count: String(task.toolUseCount) })}</span>` : nothing}
                ${task.diffStat ? html`<span aria-hidden="true">·</span>${renderDiffStatChips(task.diffStat)}` : nothing}
                ${task.runtime !== "subagent" ? html`<span aria-hidden="true">·</span><span>${taskRuntimeLabel(task)}</span>` : nothing}
              </div>`
            : nothing
        }
      </div>
      ${
        task && active && backgroundTasks?.canCancel
          ? html`<div class="sidebar-header__actions">
              <button
                class="btn btn--ghost btn--sm"
                type="button"
                aria-label=${t("chat.backgroundTasks.stopTask", { title })}
                ?disabled=${cancelling || !backgroundTasks.connected}
                @click=${() => backgroundTasks.onCancel(task.id)}
              >
                ${cancelling ? icons.loader : icons.stop} ${t("chat.runControls.stop")}
              </button>
            </div>`
          : nothing
      }
    </div>
  `;
}

function renderTaskObservation(task: TaskSummary, props: BackgroundTasksProps) {
  const active = isActiveTask(task);
  const currentTool = backgroundTaskIsExecuting(task) ? task.execution?.currentTool : undefined;
  const activityAt = active ? taskTimestampMs(task.execution?.lastActivityAt) : 0;
  const wait = active && task.execution?.state === "waiting" ? task.execution.wait : undefined;
  const delivery = backgroundTaskDeliveryLabel(task);
  const lastTool = active && !currentTool ? task.lastToolName : undefined;
  if (!currentTool && !activityAt && !wait && !delivery && !lastTool) {
    return nothing;
  }
  return html`<div class="chat-task-detail__observation">
    ${
      currentTool
        ? html`<div class="chat-task-detail__fact">
            <span class="chat-task-detail__fact-label"
              >${t("chat.backgroundTasks.currentTool")}</span
            >
            <code>${currentTool.name}</code>
            <openclaw-elapsed-time
              .startMs=${taskTimestampMs(currentTool.startedAt)}
            ></openclaw-elapsed-time>
          </div>`
        : lastTool
          ? html`<div class="chat-task-detail__fact">
              <span class="chat-task-detail__fact-label"
                >${t("chat.backgroundTasks.lastTool")}</span
              >
              <code>${lastTool}</code>
            </div>`
          : nothing
    }
    ${
      activityAt
        ? html`<div class="chat-task-detail__fact">
            <span class="chat-task-detail__fact-label"
              >${t("chat.backgroundTasks.lastActivity")}</span
            >
            <span
              ><openclaw-elapsed-time .startMs=${activityAt}></openclaw-elapsed-time>
              ${t("chat.backgroundTasks.activityAgo")}</span
            >
          </div>`
        : nothing
    }
    ${
      wait?.kind === "children" && wait.pendingCount !== undefined
        ? html`<div class="chat-task-detail__fact">
            ${t(wait.pendingCount === 1 ? "chat.backgroundTasks.pendingChildOne" : "chat.backgroundTasks.pendingChildMany", { count: String(wait.pendingCount) })}
          </div>`
        : nothing
    }
    ${
      wait?.dependencies?.some((dependency) => dependency.label)
        ? html`<ul class="chat-task-detail__dependencies">
            ${wait.dependencies
              .filter((dependency) => dependency.label)
              .map((dependency) => {
                const child = dependency.taskId
                  ? props.tasks?.find((candidate) => candidate.id === dependency.taskId)
                  : undefined;
                return html`<li>
                  ${child && props.onOpenTaskDetail ? html`<button class="chat-task-detail__dependency" type="button" @click=${() => props.onOpenTaskDetail?.(child)}>${dependency.label}</button>` : dependency.label}
                </li>`;
              })}
          </ul>`
        : nothing
    }
    ${delivery ? html`<div class="chat-task-detail__delivery ${task.deliveryStatus === "failed" || task.deliveryStatus === "parent_missing" ? "chat-task-detail__delivery--error" : ""}">${delivery}</div>` : nothing}
  </div>`;
}

function renderTaskTranscript(params: {
  host: TaskTranscriptHost;
  task: TaskSummary;
  transcriptSessionKey?: string;
  loadFullAssistantMessage?: SidebarFullMessageLoader | null;
}): TemplateResult {
  const load = readTaskTranscript(params.host, {
    taskId: params.task.id,
  });
  const messages = load.status === "loaded" ? load.messages : [];
  const capacityMessage = load.status === "loading" ? undefined : load.capacityMessage;
  const { loadFullAssistantMessage: loader, transcriptSessionKey: sessionKey } = params;
  const state = params.host.taskDetailState;
  const recovery =
    loader && sessionKey && state
      ? {
          getState: (messageId: string) => state.fullMessages.get(messageId),
          request: (messageId: string) => {
            if (params.host.taskDetailState === state) {
              void requestTaskFullMessage(params.host, {
                loader,
                sessionKey,
                agentId: params.task.agentId,
                messageId,
              });
            }
          },
        }
      : undefined;
  return html`<div
    class="sidebar-content chat-task-detail__content"
    ${ref(taskScrollRef(params.task.id, messages))}
  >
    ${renderTaskNow(params.task)}
    ${load.status === "loading" ? renderPanelLoadingSkeleton("review", t("chat.backgroundTasks.transcriptLoading")) : nothing}
    ${
      load.status === "error" || (load.status === "loaded" && load.error)
        ? html`<div class="chat-task-detail__state chat-task-detail__state--error" role="status">
            ${capacityMessage ?? t("chat.backgroundTasks.transcriptFailed")}
            ${
              capacityMessage
                ? nothing
                : html`<button
                    class="btn btn--sm"
                    type="button"
                    ?disabled=${load.status === "loaded" && load.loading}
                    @click=${() => retryTaskTranscript(params.host)}
                  >
                    ${t("common.retry")}
                  </button>`
            }
          </div>`
        : nothing
    }
    ${load.status === "loaded" && load.nextCursor && !capacityMessage ? renderChatHistoryBoundary({ hasMore: true, loading: load.loading, onShowEarlier: () => loadOlderTaskTranscript(params.host) }) : nothing}
    ${load.status === "loaded" && !messages.length && !load.nextCursor && !load.error ? html`<div class="chat-task-detail__state">${t("chat.backgroundTasks.transcriptEmpty")}</div>` : nothing}
    ${renderChatTranscriptFeed(messages, recovery)}
  </div>`;
}

function renderTaskFallback(
  task: TaskSummary,
  backgroundTasks: BackgroundTasksProps,
  host: TaskDetailHost,
): TemplateResult {
  resetTaskDetail(host);
  loadTaskDetail(task, backgroundTasks);
  return html`<div class="sidebar-content chat-task-detail__fallback">
    ${renderTaskNow(task)} ${renderTaskInspector(task, backgroundTasks)}
  </div>`;
}

function renderTaskInspector(task: TaskSummary, props: BackgroundTasksProps): TemplateResult {
  const detailedTask = props.taskDetails.get(task.id);
  const newest = newestTaskSnapshot(task, detailedTask);
  const output = taskDetail(newest);
  const detailLoading = props.taskDetailLoadingIds.has(task.id);
  const detailError = props.taskDetailErrors.get(task.id);
  if (detailLoading && !detailError) {
    return renderPanelLoadingSkeleton("review", t("chat.backgroundTasks.detailLoading"));
  }
  return html`
    ${
      detailError
        ? html`<div
            class="chat-tasks-rail__task-inspector-state chat-tasks-rail__task-inspector-state--error"
          >
            ${detailError}
            <!-- The render-driven load skips errored tasks to avoid a per-paint
               retry loop, so without this the panel dead-ends whenever the task
               row that could re-open it is not on screen. -->
            <button
              class="chat-tasks-rail__task-inspector-retry"
              type="button"
              ?disabled=${detailLoading}
              @click=${() => props.onLoadDetail?.(task)}
            >
              ${t("chat.backgroundTasks.detailRetry")}
            </button>
          </div>`
        : nothing
    }
    <div class="chat-tasks-rail__detail-blocks">
      <section class="chat-tasks-rail__task-inspector-block">
        <div class="chat-tasks-rail__task-inspector-label">${t("chat.backgroundTasks.prompt")}</div>
        <pre>${detailedTask?.prompt ?? t("chat.backgroundTasks.promptUnavailable")}</pre>
      </section>
      <section class="chat-tasks-rail__task-inspector-block">
        <div class="chat-tasks-rail__task-inspector-label">${t("chat.backgroundTasks.output")}</div>
        <pre>${output ?? t("chat.backgroundTasks.outputPending")}</pre>
      </section>
    </div>
  `;
}

function loadTaskDetail(task: TaskSummary, backgroundTasks: BackgroundTasksProps) {
  if (
    !backgroundTasks.taskDetails.has(task.id) &&
    !backgroundTasks.taskDetailErrors.has(task.id) &&
    !backgroundTasks.taskDetailLoadingIds.has(task.id)
  ) {
    backgroundTasks.onLoadDetail?.(task);
  }
}

function renderTaskNow(task: TaskSummary) {
  const active = isActiveTask(task);
  const text = active ? task.progressSummary : task.terminalSummary || task.error;
  return text
    ? html`<div
        class="chat-task-feed__now ${!active && !task.terminalSummary && task.error ? "chat-task-feed__error" : ""}"
      >
        <span class="chat-task-feed__label"
          >${active ? t(backgroundTaskIsExecuting(task) ? "chat.backgroundTasks.now" : "chat.backgroundTasks.latestUpdate") : backgroundTaskStatusLabel(task)}</span
        >
        ${text}
      </div>`
    : nothing;
}

type TaskScrollCorrection = { kind: "bottom" } | { kind: "prepend"; top: number; height: number };
const taskScroll = new WeakMap<
  Element,
  { taskId: string; first: unknown; frame: number; pending: TaskScrollCorrection | undefined }
>();
function taskScrollRef(taskId: string, messages: unknown[]) {
  return (element: Element | undefined) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    const previous = taskScroll.get(element);
    const top = element.scrollTop;
    const height = element.scrollHeight;
    const initial = previous?.taskId !== taskId || previous.first === undefined;
    const prepend = !initial && messages.indexOf(previous.first) > 0;
    const pinned = height - top - element.clientHeight <= 24;
    // A correction scheduled by an earlier render keeps its measurements: a
    // second render before the frame runs would otherwise see the prepended
    // head as current and drop the offset that keeps the reader in place.
    const pending: TaskScrollCorrection | undefined = prepend
      ? { kind: "prepend", top, height }
      : initial
        ? { kind: "bottom" }
        : (previous?.pending ?? (pinned ? { kind: "bottom" } : undefined));
    if (previous) {
      cancelAnimationFrame(previous.frame);
    }
    const frame = requestAnimationFrame(() => {
      const state = taskScroll.get(element);
      if (state) {
        state.pending = undefined;
      }
      if (!element.isConnected || !pending) {
        return;
      }
      element.scrollTop =
        pending.kind === "prepend"
          ? pending.top + element.scrollHeight - pending.height
          : element.scrollHeight;
    });
    taskScroll.set(element, { taskId, first: messages[0], frame, pending });
  };
}
