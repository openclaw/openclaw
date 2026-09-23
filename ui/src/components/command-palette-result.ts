import { html, nothing } from "lit";
import { escapeRegExp } from "../../../src/shared/regexp.ts";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";
import { icons } from "./icons.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import { renderSessionOwnerAvatar } from "./session-owner-chip.ts";

// Preserve source offsets when case folding expands Unicode characters.
// The pattern is literal and Lit escapes every rendered text segment.
function highlightMatch(text: string, query: string) {
  const needle = query.trim();
  const match = needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
  const index = match?.index ?? -1;
  return !match
    ? text
    : html`
        ${text.slice(0, index)}<mark>${text.slice(index, index + match[0].length)}</mark>${text.slice(index + match[0].length)}
      `;
}

export function renderCommandPaletteResult(
  item: CommandPaletteItem,
  query: string,
  agent?: GatewayAgentRow,
  identity?: AgentIdentityResult | null,
) {
  const session = item.session;
  const owner = session?.owner?.actor;
  const agentName = agent ? normalizeAgentLabel(agent, identity) : undefined;
  return html`
    ${
      agent
        ? html`<span class="cmd-palette__avatar" aria-hidden="true">
            ${renderAgentIdentityAvatar({ id: agent.id, avatar: resolveAgentAvatarUrl(agent, identity), textAvatar: resolveAgentTextAvatar(agent, identity) })}
            ${owner?.id ? html`<span class="cmd-palette__owner">${renderSessionOwnerAvatar({ ...owner, id: owner.id })}</span>` : nothing}
          </span>`
        : html`<span class="nav-item__icon" aria-hidden="true">${icons[item.icon]}</span>`
    }
    <span class="cmd-palette__item-copy">
      <span class="cmd-palette__item-heading">
        <span class="cmd-palette__item-title">${highlightMatch(item.label, query)}</span>
        ${session?.updatedAt ? html`<span class="cmd-palette__item-time">${formatRelativeTimestamp(session.updatedAt, { fallback: "" })}</span>` : nothing}
      </span>
      ${session ? html`<span class="cmd-palette__item-meta">${agentName}${owner?.id ? html`<span aria-hidden="true"> · </span>${t("sessionsView.ownedBy", { name: owner.label || owner.id })}` : nothing}</span>` : nothing}
      ${item.description ? html`<span class="cmd-palette__item-desc">${highlightMatch(item.description, query)}</span>` : nothing}
    </span>
  `;
}
