import { html, nothing } from "lit";
import {
  browserRouteKey,
  browserTabKey,
  type BrowserTabSelection,
} from "../../../components/browser/browser-target.ts";
import { browserTabCardRevision } from "../../../lib/chat/browser-tab-preview.ts";
import type { MessageGroup, ToolCard } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { renderPluginSurface } from "../../../plugins/control-ui-view.ts";
import type { WorkGroupRenderItem } from "../chat-thread-grouping.ts";
import type { PluginToolIcons } from "../chat-tool-icon-controller.ts";
import type { ToolCardOptions } from "./chat-tool-cards.solid.tsx";
import { type ToolRenderOptions, toolResultSurfaceProps } from "./chat-tool-render-model.ts";
import { renderToolPreview } from "./widget-card.ts";
export {
  resolveCollapsedToolDetail,
  syncToolDisclosureOverflow,
} from "./chat-tool-cards.solid.tsx";

export function renderBrowserTabPreviews(
  groups: readonly MessageGroup[],
  options: { sessionKey?: string; latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection> },
  placePreview?: (groupKey: string, content: unknown) => void,
) {
  const cards = groups.flatMap((group) =>
    group.messages.flatMap((item) =>
      extractToolCardsCached(item.message)
        .filter((card) => card.browserTab)
        .map((card) => ({ card, groupKey: group.key })),
    ),
  );
  // Select each tab's final state before collapsing reopened pages. A newer
  // blank/non-web result must still retire that tab's older web preview.
  const seenTabs = new Set<string>();
  const seenPages = new Set<string>();
  return cards
    .toReversed()
    .flatMap(({ card, groupKey }) => {
      if (!card.browserTab || resolveToolCardOutcome(card, false) !== "succeeded") {
        return [];
      }
      const tabKey = browserTabKey(card.browserTab);
      if (seenTabs.has(tabKey)) {
        return [];
      }
      seenTabs.add(tabKey);
      const preview = card.preview;
      if (preview?.kind !== "browser-tab") {
        return [];
      }
      // Browser/history descriptors cap URLs at 2,048 UTF-16 units, or 2,047
      // when a surrogate pair straddles the cut. Keep ambiguous prefixes per tab.
      const pageKey =
        preview.url.length < 2_047
          ? JSON.stringify([browserRouteKey(preview), preview.url])
          : tabKey;
      if (seenPages.has(pageKey)) {
        return [];
      }
      seenPages.add(pageKey);
      return [{ card, groupKey, preview }];
    })
    .toReversed()
    .map(({ card, groupKey, preview }) => {
      const revision = browserTabCardRevision(card);
      const content = renderToolPreview(preview, "chat_tool", {
        browserTabRevision: revision ? JSON.stringify([options.sessionKey, revision]) : undefined,
        browserTabLatest: Boolean(
          revision && options.latestBrowserTabs?.get(browserTabKey(preview))?.revision === revision,
        ),
      });
      placePreview?.(groupKey, content);
      return content;
    });
}

export function renderWorkGroupBrowserTabPreviews(
  items: readonly WorkGroupRenderItem[],
  options: Parameters<typeof renderBrowserTabPreviews>[1],
) {
  const byAnchor = new Map<string, unknown[]>();
  // Deduplicate the whole turn before placing previews, so later blank tabs or
  // repeated page opens cannot resurrect an earlier preview across an answer.
  for (const item of items) {
    renderBrowserTabPreviews(item.groups, options, (groupKey, content) => {
      const anchor = item.previewAfterGroup?.get(groupKey) ?? item.key;
      const previews = byAnchor.get(anchor) ?? [];
      previews.push(content);
      byAnchor.set(anchor, previews);
    });
  }
  return byAnchor;
}

// Lit callers retain their plugin slot; Solid owns the fallback card and its children.
// The stable child subtree carries Lit updates while Solid parks it collapsed.
export function renderToolCard(card: ToolCard, options: ToolCardOptions & { children?: unknown }) {
  return renderPluginToolResult(
    card,
    options,
    html`<openclaw-chat-tool-card
      style="display: contents"
      .card=${card}
      .options=${options}
      .hasChildren=${Boolean(options.children)}
      ><div style="display: contents">
        ${options.expanded ? options.children : nothing}
      </div></openclaw-chat-tool-card
    >`,
  );
}

export function renderToolIcon(
  name: string,
  tool?: { toolName: string; pluginToolIcons?: PluginToolIcons },
) {
  return html`<openclaw-chat-tool-icon
    style="display: contents"
    .name=${name}
    .tool=${tool}
  ></openclaw-chat-tool-icon>`;
}

export function renderToolApprovalReviews(card: ToolCard) {
  return html`<openclaw-chat-tool-reviews
    style="display: contents"
    .card=${card}
  ></openclaw-chat-tool-reviews>`;
}

function renderPluginToolResult(
  card: ToolCard | null | undefined,
  opts: ToolRenderOptions & { expanded: boolean },
  defaultView: unknown,
) {
  if (!card) {
    return defaultView;
  }
  return renderPluginSurface(
    "tool-result",
    toolResultSurfaceProps(card, opts),
    defaultView,
    opts.presented ?? true,
  );
}
