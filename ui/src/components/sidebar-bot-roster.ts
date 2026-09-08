import { html, nothing } from "lit";
import type { AgentsListResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import {
  formatBotRoleLine,
  listSelectableAgents,
  normalizeAgentLabel,
  shouldShowBotRoster,
} from "../lib/agents/display.ts";
import { deriveAvatarInitial, resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";

export function renderSidebarBotRoster(params: {
  agentsList: AgentsListResult | null | undefined;
  activeAgentId: string;
  onSelect: (agentId: string) => void;
}) {
  const agentsList = params.agentsList;
  if (!agentsList || !shouldShowBotRoster(agentsList)) {
    return nothing;
  }
  const bots = listSelectableAgents(agentsList.agents);
  return html`
    <nav class="sidebar-bot-roster" aria-label=${t("agentChip.bots")}>
      ${bots.map((bot) => {
        const agentId = normalizeAgentId(bot.id);
        const name = normalizeAgentLabel(bot);
        const role = formatBotRoleLine(bot);
        const active = agentId === params.activeAgentId;
        const avatarUrl = resolveAgentAvatarUrl(bot);
        const avatarText = bot.identity?.emoji || deriveAvatarInitial(name || agentId) || "?";
        return html`
          <button
            type="button"
            class="sidebar-bot-roster__bot ${active ? "is-active" : ""}"
            aria-current=${active ? "true" : "false"}
            aria-label=${role ? `${name} · ${role}` : name}
            @click=${() => params.onSelect(agentId)}
          >
            <span class="sidebar-bot-roster__avatar" aria-hidden="true">
              ${
                avatarUrl
                  ? html`<img src=${avatarUrl} alt="" decoding="async" />`
                  : html`<span>${avatarText}</span>`
              }
            </span>
            <span class="sidebar-bot-roster__meta">
              <span class="sidebar-bot-roster__name">${name}</span>
              ${role ? html`<span class="sidebar-bot-roster__role">${role}</span>` : nothing}
            </span>
          </button>
        `;
      })}
    </nav>
  `;
}
