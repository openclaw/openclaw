import { html, nothing } from "lit";
import { formatDurationHuman, formatRelativeTimestamp, formatTokens } from "../../format.ts";
import type { TaskBoardCardVM } from "../../task-board/types.ts";

function statusLabel(status: TaskBoardCardVM["status"]) {
  switch (status) {
    case "queued":
      return "queued";
    case "in_progress":
      return "in progress";
    case "waiting":
      return "waiting";
    case "blocked":
      return "blocked";
    case "paused":
      return "paused";
    case "done":
      return "done";
    case "disabled":
      return "disabled";
    case "error":
      return "error";
    default:
      return status;
  }
}

function badgeClass(kind: "status" | "health", value: string) {
  if (value === "error" || value === "blocked") {
    return "pill danger";
  }
  if (value === "warning" || value === "waiting") {
    return "pill warning";
  }
  if (value === "stale" || value === "paused" || value === "disabled") {
    return "pill muted";
  }
  return kind === "health" ? "pill success" : "pill";
}

function renderTime(label: string, value: string | null) {
  if (!value) {
    return nothing;
  }
  return html`<div class="muted" style="font-size: 12px;">${label}：${formatRelativeTimestamp(Date.parse(value))}</div>`;
}

function renderDuration(label: string, seconds: number | null) {
  if (seconds == null) {
    return nothing;
  }
  return html`<div class="muted" style="font-size: 12px;">${label}：${formatDurationHuman(seconds * 1000)}</div>`;
}

export function renderTaskCard(card: TaskBoardCardVM) {
  return html`
    <article class="card" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="row" style="justify-content: space-between; align-items: flex-start; gap: 12px;">
        <div>
          <div class="card-title">${card.title}</div>
          <div class="card-sub">${card.owner}</div>
        </div>
        <div class="row" style="gap: 6px; flex-wrap: wrap; justify-content: flex-end;">
          <span class=${badgeClass("status", card.status)}>${statusLabel(card.status)}</span>
          <span class=${badgeClass("health", card.health)}>${card.health}</span>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px;">
        <div>
          <div class="muted" style="font-size: 12px;">进度</div>
          <div>${card.progressPercent != null ? `${card.progressPercent}%` : "—"}</div>
        </div>
        <div>
          <div class="muted" style="font-size: 12px;">token</div>
          <div>${card.tokenUsage.value != null ? formatTokens(card.tokenUsage.value) : "—"}</div>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 4px;">
        ${renderTime("started", card.startedAt)}
        ${renderTime("last run", card.lastRunAt)}
        ${renderTime("next run", card.nextRunAt)}
        ${renderDuration("running for", card.runningForSec)}
        ${renderDuration("waiting for", card.waitingForSec)}
      </div>

      ${card.summary ? html`<div>${card.summary}</div>` : nothing}
      ${card.blocker ? html`<div class="pill danger" style="width: fit-content;">${card.blocker}</div>` : nothing}

      <div class="muted" style="font-size: 12px;">
        source: ${card.sourceOfTruth.join(" + ")}${card.tokenUsage.source ? ` · token=${card.tokenUsage.source}` : ""}
      </div>
    </article>
  `;
}
