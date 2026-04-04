import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../icons.ts";
import { type GatewaySessionRow, type SessionsListResult } from "../types.ts";
import { renderSessionItem, type SessionItemProps } from "./session-item.ts";

export type SessionSidebarProps = {
  sessions: SessionsListResult | null;
  activeSessionKey: string;
  onSessionSelect: (key: string) => void;
  onNewSession: () => void;
  onClose: () => void;
  loading?: boolean;
  basePath?: string;
};

export function renderSessionSidebar(props: SessionSidebarProps): TemplateResult {
  const { sessions, activeSessionKey, onSessionSelect, onNewSession, onClose, loading } = props;
  const rows = sessions?.sessions ?? [];

  // Group sessions by recency
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const today: GatewaySessionRow[] = [];
  const yesterday: GatewaySessionRow[] = [];
  const older: GatewaySessionRow[] = [];

  for (const row of rows) {
    const ts = row.updatedAt ?? 0;
    if (!ts) {
      older.push(row);
    } else if (now - ts < dayMs) {
      today.push(row);
    } else if (now - ts < 2 * dayMs) {
      yesterday.push(row);
    } else {
      older.push(row);
    }
  }

  const renderGroup = (label: string, items: GatewaySessionRow[]) => {
    if (items.length === 0) {return nothing;}
    return html`
      <div class="session-sidebar__group">
        <div class="session-sidebar__group-label">${label}</div>
        ${repeat(
          items,
          (row) => row.key,
          (row) => renderSessionItem({
            session: row,
            isActive: row.key === activeSessionKey,
            onSelect: onSessionSelect,
            basePath: props.basePath,
          } as SessionItemProps),
        )}
      </div>
    `;
  };

  return html`
    <aside class="session-sidebar" role="navigation" aria-label="Session list">
      <div class="session-sidebar__header">
        <h2 class="session-sidebar__title">Sessions</h2>
        <button
          class="session-sidebar__close"
          type="button"
          aria-label="Close session sidebar"
          @click=${onClose}
        >
          ${icons.x}
        </button>
      </div>

      <div class="session-sidebar__content">
        ${loading ? html`
          <div class="session-sidebar__loading">
            ${icons.loader} Loading sessions...
          </div>
        ` : nothing}

        ${rows.length === 0 && !loading ? html`
          <div class="session-sidebar__empty">
            No sessions found
          </div>
        ` : nothing}

        ${renderGroup("Today", today)}
        ${renderGroup("Yesterday", yesterday)}
        ${renderGroup("Older", older)}
      </div>

      <div class="session-sidebar__footer">
        <button
          class="session-sidebar__new-btn"
          type="button"
          @click=${onNewSession}
          title="New session"
        >
          ${icons.plus}
          <span>New Chat</span>
        </button>
      </div>
    </aside>
  `;
}