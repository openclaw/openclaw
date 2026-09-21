import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import remend from "remend";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { isActiveTask, partitionTasks, taskTimestampMs } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  backgroundTaskDeliveryLabel,
  backgroundTaskIsExecuting,
  backgroundTaskStatusLabel,
} from "./chat-background-tasks-shared.ts";

registerBackgroundTasksEnglish();

const SUBAGENT_ACTIVITY_LIMIT = 5;
const SUBAGENT_ACTIVITY_TERMINAL_RETENTION_MS = 60_000;

export type SubagentActivityPresentation = {
  rows: TaskSummary[];
  overflowCount: number;
  taskIds: ReadonlySet<string>;
  nextExpiryAt: number | null;
};

export function deriveSubagentActivity(params: {
  tasks: readonly TaskSummary[];
  sessionKey: string;
  terminalObservedAtByTask: ReadonlyMap<string, number>;
  canonicalizeSessionKey: (sessionKey: string | undefined) => string;
  now?: number;
}): SubagentActivityPresentation {
  const now = params.now ?? Date.now();
  const requesterSessionKey = params.canonicalizeSessionKey(params.sessionKey);
  let nextExpiryAt: number | null = null;
  const eligible = params.tasks.filter((task) => {
    const taskRequesterSessionKey = params.canonicalizeSessionKey(task.sessionKey);
    const childSessionKey = params.canonicalizeSessionKey(task.childSessionKey);
    const isChild =
      task.runtime === "subagent" ||
      (task.runtime === "cli" &&
        Boolean(childSessionKey) &&
        childSessionKey !== taskRequesterSessionKey);
    if (!isChild || !requesterSessionKey || taskRequesterSessionKey !== requesterSessionKey) {
      return false;
    }
    if (isActiveTask(task)) {
      return true;
    }
    const terminalAt =
      params.terminalObservedAtByTask.get(task.id) ??
      taskTimestampMs(task.endedAt ?? task.updatedAt);
    const expiresAt = terminalAt + SUBAGENT_ACTIVITY_TERMINAL_RETENTION_MS;
    if (terminalAt <= 0 || expiresAt <= now) {
      return false;
    }
    nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
    return true;
  });
  const { active, recent } = partitionTasks(eligible);
  // Share the Tasks panel's stable lifecycle order. Reserve one result slot,
  // but let ongoing work keep the rest during a burst of completions.
  const visibleActive = active.slice(0, SUBAGENT_ACTIVITY_LIMIT - Math.min(recent.length, 1));
  const rows = [
    ...recent.slice(0, SUBAGENT_ACTIVITY_LIMIT - visibleActive.length),
    ...visibleActive,
  ];
  const overflowCount = Math.max(0, eligible.length - SUBAGENT_ACTIVITY_LIMIT);
  return {
    rows,
    overflowCount,
    taskIds: new Set(eligible.map((task) => task.id)),
    nextExpiryAt,
  };
}

function subagentActivitySnippet(task: TaskSummary): string | undefined {
  if (!isActiveTask(task)) {
    return task.terminalSummary?.trim() || task.error?.trim() || undefined;
  }
  return (
    task.lastActivity?.trim() ||
    task.progressSummary?.trim() ||
    (task.lastToolName?.trim()
      ? `${t("chat.backgroundTasks.lastTool")}: ${task.lastToolName.trim()}`
      : undefined) ||
    undefined
  );
}

function renderSubagentActivityIndicator(task: TaskSummary): TemplateResult {
  const indicatorStatus =
    task.status === "completed" &&
    (task.deliveryStatus === "failed" || task.deliveryStatus === "parent_missing")
      ? "failed"
      : task.status;
  const badge =
    indicatorStatus === "completed"
      ? icons.check
      : indicatorStatus === "failed"
        ? icons.alertTriangle
        : indicatorStatus === "timed_out"
          ? icons.clock
          : nothing;
  return html`<span
    class="chat-subagent-activity__indicator chat-subagent-activity__indicator--${indicatorStatus}"
    aria-hidden="true"
  >
    <span
      class="chat-subagent-activity__claw ${backgroundTaskIsExecuting(task) ? "chat-reading-indicator" : ""}"
      >${icons.claw}</span
    >
    ${
      badge === nothing
        ? nothing
        : html`<span class="chat-subagent-activity__badge">${badge}</span>`
    }
  </span>`;
}

function renderSubagentActivityRow(
  task: TaskSummary,
  onOpenTaskDetail?: (task: TaskSummary) => void,
): TemplateResult {
  const rawSnippet = subagentActivitySnippet(task);
  // Previews can end mid-emphasis. Repair delimiters without adding escapes
  // intended for a Markdown renderer; the row and tooltip stay plain text.
  const snippet = rawSnippet
    ? flattenMarkdownToPlainText(
        remend(rawSnippet, {
          katex: false,
          links: false,
          images: false,
          comparisonOperators: false,
          singleTilde: false,
          setextHeadings: false,
          htmlTags: false,
        }),
      )
    : undefined;
  const title = task.title?.trim();
  const label = title || t("chat.backgroundTasks.subagentActivity.untitled");
  const statusLabel = backgroundTaskStatusLabel(task);
  const deliveryLabel = backgroundTaskDeliveryLabel(task);
  const statusDescription = deliveryLabel ? `${statusLabel} — ${deliveryLabel}` : statusLabel;
  const content = html`
    ${renderSubagentActivityIndicator(task)}
    <span class="chat-subagent-activity__label">${label}</span>
    ${keyed(
      `${task.status}:${snippet ?? ""}`,
      html`<span class="chat-subagent-activity__snippet chat-subagent-activity__snippet--updated"
        >${snippet ?? ""}</span
      >`,
    )}
  `;
  const row = !onOpenTaskDetail
    ? html`<div
        class="chat-subagent-activity__row"
        data-subagent-task-id=${task.id}
        role="status"
        aria-live="off"
        aria-label=${`${label}. ${statusDescription}`}
      >
        ${content}
      </div>`
    : html`<button
        class="chat-subagent-activity__row chat-subagent-activity__row--interactive"
        data-subagent-task-id=${task.id}
        type="button"
        aria-label=${`${t("chat.backgroundTasks.subagentActivity.openDetails", { title: label })}. ${statusDescription}`}
        @click=${() => onOpenTaskDetail(task)}
      >
        ${content}
      </button>`;
  return html`<openclaw-tooltip
    class="chat-subagent-activity__tooltip"
    .content=${[label, statusDescription, snippet].filter(Boolean).join("\n")}
    .describe=${false}
    >${row}</openclaw-tooltip
  >`;
}

export function renderSubagentActivity(
  presentation: SubagentActivityPresentation,
  onOpenTaskDetail?: (task: TaskSummary) => void,
): TemplateResult | typeof nothing {
  if (presentation.rows.length === 0) {
    return nothing;
  }
  return html`
    <div
      class="chat-subagent-activity"
      aria-label=${t("chat.backgroundTasks.subagentActivity.label")}
    >
      ${repeat(
        presentation.rows,
        (task) => task.id,
        (task) => renderSubagentActivityRow(task, onOpenTaskDetail),
      )}
      ${
        presentation.overflowCount > 0
          ? html`<div class="chat-subagent-activity__overflow">
              ${t("chat.backgroundTasks.subagentActivity.moreSubagents", {
                count: String(presentation.overflowCount),
              })}
            </div>`
          : nothing
      }
    </div>
  `;
}
