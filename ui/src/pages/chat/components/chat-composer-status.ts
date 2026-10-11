import { html, nothing } from "lit";
import { icons } from "../../../components/icons.ts";
import "../../../components/elapsed-time.tsx";
import { t } from "../../../i18n/index.ts";
import type { ChatSubagentWait } from "../chat-subagent-wait.ts";
import type { FallbackStatus } from "../tool-stream-contract.ts";

const FALLBACK_TOAST_DURATION_MS = 8000;

export function renderComposerRunStatus(options: {
  waitingSubagents?: ChatSubagentWait | null;
  working: boolean;
  onOpenSubagents?: (focus?: boolean) => void;
}) {
  const wait = options.waitingSubagents;
  if (!wait && !options.working) {
    return nothing;
  }
  const label = wait
    ? wait.runningCount === 1
      ? t("chat.waitingOnSubagentCount", { count: "1" })
      : wait.runningCount > 1
        ? t("chat.waitingOnSubagentsCount", { count: String(wait.runningCount) })
        : (wait.sessionCount ?? 0) > 1
          ? t("chat.waitingOnSessionsCount", { count: String(wait.sessionCount) })
          : wait.sessionCount === 1
            ? t("chat.waitingOnSession")
            : t("chat.waitingOnSubagents")
    : t("common.working");
  const startedAt = wait?.child?.startedAt ?? wait?.startedAt;
  return html`<div
    class="agent-chat__composer-run-status ${wait ? "agent-chat__composer-run-status--waiting" : "agent-chat__composer-run-status--working"}"
    role="status"
    aria-live="off"
  >
    <span class="agent-chat__composer-run-spinner" aria-hidden="true">${icons.loader}</span>
    <span>${label}</span>
    ${
      wait?.child
        ? html`<span aria-hidden="true">· </span
            ><span class="agent-chat__composer-wait-child" title=${wait.child.label}
              >${wait.child.label}</span
            >`
        : nothing
    }
    ${
      wait && startedAt != null
        ? html`<span aria-hidden="true">· </span
            ><span class="agent-chat__composer-wait-elapsed"
              >${t("chat.composer.running")}
              <openclaw-elapsed-time .startMs=${startedAt}></openclaw-elapsed-time
            ></span>`
        : nothing
    }
    ${
      wait && !((wait.sessionCount ?? 0) > 0 && wait.runningCount === 0) && options.onOpenSubagents
        ? html`<button type="button" @click=${() => options.onOpenSubagents?.(true)}>
            ${t("chat.composer.viewSubagents")}
          </button>`
        : nothing
    }
  </div>`;
}

export function renderFallbackIndicator(status: FallbackStatus | null | undefined) {
  if (!status) {
    return nothing;
  }
  const phase = status.phase ?? "active";
  const elapsed = Date.now() - status.occurredAt;
  if (elapsed >= FALLBACK_TOAST_DURATION_MS) {
    return nothing;
  }
  const details = [
    t("chat.composer.fallbackSelected", { model: status.selected }),
    t("chat.composer.fallbackCurrent", {
      model: phase === "cleared" ? status.selected : status.active,
    }),
    phase === "cleared" && status.previous
      ? t("chat.composer.fallbackPrevious", { model: status.previous })
      : null,
    status.reason ? t("chat.composer.fallbackReason", { reason: status.reason }) : null,
    status.attempts.length > 0
      ? t("chat.composer.fallbackAttempts", {
          attempts: status.attempts.slice(0, 3).join(" | "),
        })
      : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const message =
    phase === "cleared"
      ? t("chat.composer.fallbackCleared", { model: status.selected })
      : t("chat.composer.fallbackActive", { model: status.active });
  const className =
    phase === "cleared"
      ? "compaction-indicator compaction-indicator--fallback-cleared"
      : "compaction-indicator compaction-indicator--fallback";
  const icon = phase === "cleared" ? icons.check : icons.brain;
  return html`
    <openclaw-tooltip .content=${details}>
      <div class=${className} role="status" aria-live="polite" aria-label=${details}>
        ${icon} ${message}
      </div>
    </openclaw-tooltip>
  `;
}
