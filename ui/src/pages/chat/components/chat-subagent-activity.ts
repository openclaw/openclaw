import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { renderThemeBrandIcon } from "../../../components/theme-brand-icon.ts";
import { t } from "../../../i18n/index.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import type { ChatSubagentActivity } from "../chat-subagent-wait.ts";
import "./chat-subagent-activity.css";

export function renderSubagentActivity(
  rows: readonly ChatSubagentActivity[],
  onOpenSubagent?: (key: string) => void,
  onOpenSession?: (key: string) => void,
  compact = false,
) {
  if (!rows.length) {
    return nothing;
  }
  return html`<div
    class="chat-subagent-activity"
    role="list"
    aria-label=${t("chat.subagentsPanel.title")}
  >
    ${repeat(
      rows,
      (row) => row.key,
      (row) => {
        const status = t(
          row.status === "queued"
            ? "common.queued"
            : row.status === "waiting"
              ? "chat.waitingOnSubagents"
              : "common.running",
        );
        const activity = row.activity || status;
        const open = row.listed ? (onOpenSubagent ?? onOpenSession) : onOpenSession;
        const content = html`
          ${
            compact
              ? html`<span
                  class="chat-details__agent-avatar"
                  style=${`--chat-details-avatar-hue: ${fnv1aUtf16(row.key) % 360}`}
                  aria-hidden="true"
                  >${icons.bot}</span
                >`
              : html`<span
                  class="chat-subagent-activity__icon ${row.status === "running" ? "chat-reading-indicator" : ""}"
                  aria-hidden="true"
                >
                  ${row.status === "running" ? renderThemeBrandIcon(icons.claw) : icons.clock}
                </span>`
          }
          <span class="chat-subagent-activity__name">${row.label}</span>
          <span class="chat-subagent-activity__status">${activity}</span>
        `;
        const description = [row.label, status, row.activity].filter(Boolean).join(". ");
        return html`<div role="listitem" data-subagent-session-key=${row.key}>
          ${
            open
              ? html`<button
                  class="chat-subagent-activity__row"
                  type="button"
                  title=${description}
                  aria-label=${description}
                  @click=${() => open(row.key)}
                >
                  ${content}
                </button>`
              : html`<div class="chat-subagent-activity__row" title=${description}>${content}</div>`
          }
        </div>`;
      },
    )}
  </div>`;
}
