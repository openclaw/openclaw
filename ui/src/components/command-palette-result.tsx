import type { JSX } from "@solidjs/web";
import MarkdownIt, { type Token } from "markdown-it";
import { createMemo, Match, Show, Switch } from "solid-js";
import { escapeRegExp } from "../../../src/shared/regexp.ts";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { normalizeAgentLabel, resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { formatRelativeTimestamp } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import { LitContent } from "../lit/solid-bridge.ts";
import { PluginArtTile } from "../pages/plugins/plugin-art-tile.tsx";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";
import { renderSessionOwnerAvatar } from "./session-owner-chip.ts";
import { Icon } from "./solid/icon.tsx";
import { renderThemeBrandIcon } from "./theme-brand-icon.ts";

// Preserve source offsets when case folding expands Unicode characters.
// The pattern is literal and Solid escapes every rendered text segment.
function matchQuery(text: string, query: string) {
  const needle = query.trim();
  return needle ? new RegExp(escapeRegExp(needle), "iu").exec(text) : null;
}

function highlightMatch(text: string, query: string) {
  const match = matchQuery(text, query);
  const index = match?.index ?? -1;
  return !match ? (
    text
  ) : (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + match[0].length)}</mark>
      {text.slice(index + match[0].length)}
    </>
  );
}

// Search rows are options, not documents: no tables, raw HTML, media loads, or
// nested links. Parse inline syntax, then let Solid escape all text and emit only
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
    parts: JSX.Element[];
    matched: boolean;
  } {
    const parts: JSX.Element[] = [];
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
            parts.push(<strong>{content.parts}</strong>);
            break;
          case "em_open":
            parts.push(<em>{content.parts}</em>);
            break;
          case "s_open":
            parts.push(<s>{content.parts}</s>);
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
        parts.push(<code>{highlightMatch(token.content, query)}</code>);
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

export function CommandPaletteResult(props: {
  item: CommandPaletteItem;
  query: string;
  agent?: GatewayAgentRow;
  identity?: AgentIdentityResult | null;
  pluginIconUrls?: Readonly<Record<string, string>>;
  onPluginIconError?: (pluginId: string) => void;
}) {
  const session = () => props.item.session;
  const owner = () => session()?.owner?.actor;
  const agentName = () =>
    props.agent ? normalizeAgentLabel(props.agent, props.identity) : undefined;
  const description = createMemo(() =>
    props.item.description
      ? session()
        ? renderSnippet(props.item.description, props.query)
        : highlightMatch(props.item.description, props.query)
      : undefined,
  );
  return (
    <>
      <Switch
        fallback={
          <span class="nav-item__icon" aria-hidden="true">
            <Show
              when={props.item.id === "panel-custodian"}
              fallback={<Icon name={props.item.icon} />}
            >
              <LitContent render={() => renderThemeBrandIcon()} />
            </Show>
          </span>
        }
      >
        <Match when={props.agent}>
          {(agent) => (
            <span class="cmd-palette__avatar" aria-hidden="true">
              <LitContent
                render={() =>
                  renderAgentIdentityAvatar({
                    id: agent().id,
                    avatar: resolveAgentAvatarUrl(agent(), props.identity),
                    textAvatar: resolveAgentTextAvatar(agent(), props.identity),
                  })
                }
              />
              <Show when={owner()?.id}>
                <span class="cmd-palette__owner">
                  <LitContent
                    render={() => renderSessionOwnerAvatar({ ...owner()!, id: owner()!.id! })}
                  />
                </span>
              </Show>
            </span>
          )}
        </Match>
        <Match when={props.item.pluginId} keyed>
          {(pluginId) => (
            <PluginArtTile
              slug={pluginId}
              name={props.item.label}
              options={{
                iconUrl: props.pluginIconUrls?.[pluginId],
                onIconError: () => props.onPluginIconError?.(pluginId),
                className: "cmd-palette__plugin-icon",
              }}
            />
          )}
        </Match>
      </Switch>
      <span class="cmd-palette__item-copy">
        <span class="cmd-palette__item-heading">
          <span class="cmd-palette__item-title">
            {highlightMatch(props.item.label, props.query)}
          </span>
          <Show when={session()?.updatedAt}>
            {(updatedAt) => (
              <span class="cmd-palette__item-time">
                {formatRelativeTimestamp(updatedAt(), { fallback: "" })}
              </span>
            )}
          </Show>
        </span>{" "}
        <Show when={session()}>
          <span class="cmd-palette__item-meta">
            {agentName()}
            <Show when={owner()?.id}>
              <span aria-hidden="true"> · </span>
              {t("sessionsView.ownedBy", { name: owner()!.label || owner()!.id! })}
            </Show>
          </span>
        </Show>{" "}
        <Show when={props.item.description}>
          <span class="cmd-palette__item-desc">{description()}</span>
        </Show>
      </span>
    </>
  );
}
