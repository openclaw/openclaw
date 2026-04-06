import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../icons.ts";
import type { GatewaySessionRow } from "../types.ts";

export type SessionItemProps = {
  session: GatewaySessionRow;
  isActive: boolean;
  onSelect: (key: string) => void;
  basePath?: string;
};

export function renderSessionItem(props: SessionItemProps): TemplateResult {
  const { session, isActive, onSelect } = props;
  const used = session.totalTokens ?? 0;
  const limit = session.contextTokens ?? 0;
  const pct = limit > 0 ? Math.min(Math.round((used / limit) * 100), 100) : 0;

  const contextColor = pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--warn)" : "var(--ok)";
  const contextWidth = `${Math.max(pct, 5)}%`;

  const displayName = session.displayName ?? session.label ?? session.key ?? "Session";
  const updatedAt = session.updatedAt
    ? formatRelativeTime(session.updatedAt)
    : "Unknown";

  return html`
    <button
      class="session-sidebar-item ${isActive ? "session-sidebar-item--active" : ""}"
      type="button"
      role="option"
      aria-selected=${isActive}
      @click=${() => onSelect(session.key)}
      title=${displayName}
    >
      <div class="session-sidebar-item__icon">
        ${isActive ? icons.check : icons.circle}
      </div>
      <div class="session-sidebar-item__content">
        <div class="session-sidebar-item__name">${displayName}</div>
        <div class="session-sidebar-item__meta">
          <span class="session-sidebar-item__updated">${updatedAt}</span>
          ${session.model ? html`<span class="session-sidebar-item__model">${session.model}</span>` : nothing}
        </div>
      </div>
      <div class="session-sidebar-item__context" title="Context usage: ${pct}%">
        <div class="session-sidebar-item__context-bar" style="width: ${contextWidth}; background: ${contextColor}"></div>
      </div>
    </button>
  `;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {return `${days}d ago`;}
  if (hours > 0) {return `${hours}h ago`;}
  if (minutes > 0) {return `${minutes}m ago`;}
  return "Just now";
}