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
import { renderThemeBrandIcon } from "./theme-brand-icon.ts";

// Preserve source offsets when case folding expands Unicode characters.
// The pattern is literal and Lit escapes every rendered text segment.
function matchQuery(text: string, query: string) {
  const needle = query.trim();
  return needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
}

function highlightMatch(text: string, query: string) {
  const match = matchQuery(text, query);
  const index = match?.index ?? -1;
  return !match
    ? text
    : html`${text.slice(0, index)}<mark>${text.slice(index, index + match[0].length)}</mark>${text.slice(index + match[0].length)}`;
}

// Search rows are options, not documents: no tables, raw HTML, media loads, or
// nested links. Parse inline syntax, then let Lit escape all text and emit only
// the small formatting vocabulary that fits the existing two-line preview.
const snippetParser = new MarkdownIt({ html: false, linkify: false });
// These URLs are display text, never navigation targets. Encoding or decoding
// them would hide matches in Unicode destinations or authored percent escapes.
snippetParser.normalizeLink = (url) => url;
snippetParser.normalizeLinkText = (url) => url;

function renderSnippet(text: string, query: string) {
  function destinationSuffix(destination: string, labelMatched: boolean): string {
    // Preserve the reason a row matched, without adding another navigation target.
    return destination && matchQuery(destination, query) && !labelMatched
      ? ` (${destination})`
      : "";
  }

  function renderTokens(tokens: IterableIterator<Token>): {
    parts: Array<string | TemplateResult>;
    matched: boolean;
  } {
    const parts: Array<string | TemplateResult> = [];
    let matched = false;
    for (const token of tokens) {
      if (token.nesting === -1) {
        break;
      }
      if (token.nesting === 1 || token.type === "image") {
        const content = renderTokens(
          token.type === "image" ? (token.children ?? []).values() : tokens,
        );
        matched ||= content.matched;
        switch (token.type) {
          case "strong_open":
            parts.push(html`<strong>${content.parts}</strong>`);
            break;
          case "em_open":
            parts.push(html`<em>${content.parts}</em>`);
            break;
          case "s_open":
            parts.push(html`<s>${content.parts}</s>`);
            break;
          case "image":
          case "link_open": {
            const destination = String(
              token.attrGet(token.type === "image" ? "src" : "href") ?? "",
            );
            const suffix = destinationSuffix(destination, content.matched);
            parts.push(...content.parts, highlightMatch(suffix, query));
            matched ||= suffix.length > 0;
            break;
          }
          default:
            parts.push(...content.parts);
        }
      } else if (token.type === "code_inline") {
        parts.push(html`<code>${highlightMatch(token.content, query)}</code>`);
        matched ||= matchQuery(token.content, query) !== null;
      } else if (token.type === "softbreak" || token.type === "hardbreak") {
        parts.push(" ");
      } else {
        parts.push(highlightMatch(token.content, query));
        matched ||= matchQuery(token.content, query) !== null;
      }
    }
    return { parts, matched };
  }
  return renderTokens((snippetParser.parseInline(text, {})[0]?.children ?? []).values()).parts;
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
          : html`<span class="nav-item__icon" aria-hidden="true"
              >${item.id === "panel-custodian" ? renderThemeBrandIcon() : icons[item.icon]}</span
            >`
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
