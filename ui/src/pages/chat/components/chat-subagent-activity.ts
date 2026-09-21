import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { html, nothing, type TemplateResult } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import remend from "remend";
import { icons } from "../../../components/icons.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { partitionTasks } from "../../../lib/tasks/data.ts";
import type { TaskSummary } from "../../../lib/tasks/task-summary.ts";
import {
  backgroundTaskIsExecuting,
  backgroundTaskStatusLabel,
} from "./chat-background-tasks-shared.ts";

registerBackgroundTasksEnglish();

const SUBAGENT_ACTIVITY_LIMIT = 5;

export type SubagentActivityPresentation = {
  rows: TaskSummary[];
  overflowCount: number;
  taskIds: ReadonlySet<string>;
};

export function deriveSubagentActivity(params: {
  tasks: readonly TaskSummary[];
  sessionKey: string;
  canonicalizeSessionKey: (sessionKey: string | undefined) => string;
}): SubagentActivityPresentation {
  const requesterSessionKey = params.canonicalizeSessionKey(params.sessionKey);
  const children = params.tasks.filter((task) => {
    const taskRequesterSessionKey = params.canonicalizeSessionKey(task.sessionKey);
    const childSessionKey = params.canonicalizeSessionKey(task.childSessionKey);
    const isChild =
      task.runtime === "subagent" ||
      (task.runtime === "cli" &&
        Boolean(childSessionKey) &&
        childSessionKey !== taskRequesterSessionKey);
    return (
      isChild && Boolean(requesterSessionKey) && taskRequesterSessionKey === requesterSessionKey
    );
  });
  const { active } = partitionTasks(children);
  const ongoing = active.filter((task) => task.execution?.state !== "finished");
  return {
    rows: ongoing.slice(0, SUBAGENT_ACTIVITY_LIMIT),
    overflowCount: Math.max(0, ongoing.length - SUBAGENT_ACTIVITY_LIMIT),
    // Finished children belong in Tasks history, including when other work keeps the aggregate visible.
    taskIds: new Set(children.map((task) => task.id)),
  };
}

function subagentActivitySnippet(task: TaskSummary): string | undefined {
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
  return html`<span
    class="chat-subagent-activity__indicator chat-subagent-activity__indicator--${task.status}"
    aria-hidden="true"
  >
    <span
      class="chat-subagent-activity__claw ${backgroundTaskIsExecuting(task) ? "chat-reading-indicator" : ""}"
      >${icons.claw}</span
    >
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
  const statusDescription = backgroundTaskStatusLabel(task);
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
