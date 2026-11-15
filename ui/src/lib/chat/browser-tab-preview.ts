import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  browserTabKey,
  type BrowserTabSelection,
} from "../../components/browser/browser-target.ts";
import type { ToolCard } from "./chat-types.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "./tool-cards.ts";

function browserTabCardRevision(card: ToolCard): string | undefined {
  return card.callId ?? card.messageId ?? card.previewRevision;
}

// History and live tool arrays are replaced, never mutated; scan each pair once
// instead of on every scroll-driven render.
const latestTabsByHistory = new WeakMap<
  readonly unknown[],
  { toolMessages: readonly unknown[]; latest: ReadonlyMap<string, BrowserTabSelection> }
>();
// Reuse the empty selection when a session has no browser results.
const emptyBrowserTabs: ReadonlyMap<string, BrowserTabSelection> = new Map();

export function latestBrowserTabCards(
  messages: readonly unknown[],
  toolMessages: readonly unknown[],
): ReadonlyMap<string, BrowserTabSelection> {
  const cached = latestTabsByHistory.get(messages);
  if (cached?.toolMessages === toolMessages) {
    return cached.latest;
  }
  let latest: Map<string, BrowserTabSelection> | undefined;
  // History precedes the current live stream. Select before search/virtualization
  // so filtering or expanding old work cannot change the current panel target.
  for (const source of [messages, toolMessages]) {
    for (const message of source) {
      if (!isRecord(message)) {
        continue;
      }
      for (const card of extractToolCardsCached(message)) {
        const revision = browserTabCardRevision(card);
        if (card.browserTab && revision && resolveToolCardOutcome(card, false) === "succeeded") {
          const key = browserTabKey(card.browserTab);
          latest ??= new Map();
          latest.delete(key);
          latest.set(key, { tab: card.browserTab, revision });
        }
      }
    }
  }
  const result = latest ?? emptyBrowserTabs;
  latestTabsByHistory.set(messages, { toolMessages, latest: result });
  return result;
}
