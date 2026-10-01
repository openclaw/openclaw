import { html, nothing, type TemplateResult } from "lit";
import MarkdownIt, { type Token } from "markdown-it";
import { escapeRegExp } from "../../../src/shared/regexp.ts";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { renderArtTile } from "../pages/plugins/consent-dialog.ts";
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
    : html`${text.slice(0, index)}<mark>${text.slice(index, index + match[0].length)}</mark>${text.slice(index + match[0].length)}`;
}

// Search rows are options, not documents: no tables, raw HTML, media loads, or
// nested links. Parse inline syntax, then let Lit escape all text and emit only
// the small formatting vocabulary that fits the existing two-line preview.
const snippetParser = new MarkdownIt({ html: false, linkify: false });

function renderSnippet(text: string, query: string) {
  function renderTokens(tokens: IterableIterator<Token>): Array<string | TemplateResult> {
    const parts: Array<string | TemplateResult> = [];
    for (const token of tokens) {
      if (token.nesting === -1) {
        break;
      }
      if (token.nesting === 1) {
        const content = renderTokens(tokens);
        switch (token.type) {
          case "strong_open":
            parts.push(html`<strong>${content}</strong>`);
            break;
          case "em_open":
            parts.push(html`<em>${content}</em>`);
            break;
          case "s_open":
            parts.push(html`<s>${content}</s>`);
            break;
          default:
            parts.push(...content);
        }
      } else if (token.type === "code_inline") {
        parts.push(html`<code>${highlightMatch(token.content, query)}</code>`);
      } else if (token.type === "softbreak" || token.type === "hardbreak") {
        parts.push(" ");
      } else {
        parts.push(highlightMatch(token.content, query));
      }
    }
    return parts;
  }
  return renderTokens((snippetParser.parseInline(text, {})[0]?.children ?? []).values());
}

export function renderCommandPaletteResult(
  item: CommandPaletteItem,
  query: string,
  agent?: GatewayAgentRow,
  identity?: AgentIdentityResult | null,
  pluginIconUrls: Readonly<Record<string, string>> = {},
  onPluginIconError?: (pluginId: string) => void,
) {
  const session = item.session;
  const owner = session?.owner?.actor;
  const agentName = agent ? normalizeAgentLabel(agent, identity) : undefined;
  const pluginId = item.pluginId;
  return html`
    ${
      agent
        ? html`<span class="cmd-palette__avatar" aria-hidden="true">
            ${renderAgentIdentityAvatar({ id: agent.id, avatar: resolveAgentAvatarUrl(agent, identity), textAvatar: resolveAgentTextAvatar(agent, identity) })}
            ${owner?.id ? html`<span class="cmd-palette__owner">${renderSessionOwnerAvatar({ ...owner, id: owner.id })}</span>` : nothing}
          </span>`
        : pluginId
          ? renderArtTile(pluginId, item.label, {
              iconUrl: pluginIconUrls[pluginId],
              onIconError: () => onPluginIconError?.(pluginId),
              className: "cmd-palette__plugin-icon",
            })
          : html`<span class="nav-item__icon" aria-hidden="true">${icons[item.icon]}</span>`
    }
    <span class="cmd-palette__item-copy">
      <span class="cmd-palette__item-heading">
        <span class="cmd-palette__item-title">${highlightMatch(item.label, query)}</span>
        ${session?.updatedAt ? html`<span class="cmd-palette__item-time">${formatRelativeTimestamp(session.updatedAt, { fallback: "" })}</span>` : nothing}
      </span>
      ${session ? html`<span class="cmd-palette__item-meta">${agentName}${owner?.id ? html`<span aria-hidden="true"> · </span>${t("sessionsView.ownedBy", { name: owner.label || owner.id })}` : nothing}</span>` : nothing}
      ${item.description ? html`<span class="cmd-palette__item-desc">${session ? renderSnippet(item.description, query) : highlightMatch(item.description, query)}</span>` : nothing}
    </span>
  `;
}
