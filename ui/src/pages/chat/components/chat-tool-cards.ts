import {
  browserRouteKey,
  browserTabKey,
  type BrowserTabSelection,
} from "../../../components/browser/browser-target.ts";
import { browserTabCardRevision } from "../../../lib/chat/browser-tab-preview.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import type { ToolPreview } from "../../../lib/chat/tool-cards.ts";
import type { WorkGroupRenderItem } from "../chat-turn-presentation.ts";

export type BrowserTabPreview = {
  preview: Extract<ToolPreview, { kind: "browser-tab" }>;
  revision?: string;
  latest: boolean;
};

export function selectBrowserTabPreviews(
  groups: readonly MessageGroup[],
  options: { sessionKey?: string; latestBrowserTabs?: ReadonlyMap<string, BrowserTabSelection> },
  placePreview?: (groupKey: string, preview: BrowserTabPreview) => void,
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
      const content: BrowserTabPreview = {
        preview,
        revision: revision ? JSON.stringify([options.sessionKey, revision]) : undefined,
        latest: Boolean(
          revision && options.latestBrowserTabs?.get(browserTabKey(preview))?.revision === revision,
        ),
      };
      placePreview?.(groupKey, content);
      return content;
    });
}

export function selectWorkGroupBrowserTabPreviews(
  items: readonly WorkGroupRenderItem[],
  options: Parameters<typeof selectBrowserTabPreviews>[1],
) {
  const byAnchor = new Map<string, BrowserTabPreview[]>();
  // Deduplicate the whole turn before placing previews, so later blank tabs or
  // repeated page opens cannot resurrect an earlier preview across an answer.
  for (const item of items) {
    selectBrowserTabPreviews(item.groups, options, (groupKey, content) => {
      const anchor = item.previewAfterGroup?.get(groupKey) ?? item.key;
      const previews = byAnchor.get(anchor) ?? [];
      previews.push(content);
      byAnchor.set(anchor, previews);
    });
  }
  return byAnchor;
}
