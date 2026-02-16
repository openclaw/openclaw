import type { ReactionBundleContext, ReactionEventItem } from "./types.js";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";

type ReactionDebounceItem = {
  reaction: ReactionEventItem;
  context: Omit<ReactionBundleContext, "reactions">;
};

const DEFAULT_BUNDLE_WINDOW_MS = 2000;

export function createReactionDebouncer(params: {
  bundleWindowMs?: number;
  onFlush: (bundle: ReactionBundleContext) => Promise<void>;
}) {
  const debounceMs = params.bundleWindowMs ?? DEFAULT_BUNDLE_WINDOW_MS;
  /** Track active keys so we can drain by session prefix. */
  const activeKeys = new Set<string>();

  const inner = createInboundDebouncer<ReactionDebounceItem>({
    debounceMs,
    buildKey: (item) => {
      const key = `${item.context.sessionKey}:${item.context.messageId}`;
      activeKeys.add(key);
      return key;
    },
    onFlush: async (items) => {
      if (items.length === 0) {
        return;
      }
      const first = items[0];
      const key = `${first.context.sessionKey}:${first.context.messageId}`;
      activeKeys.delete(key);
      const bundle: ReactionBundleContext = {
        ...first.context,
        reactions: items.map((i) => i.reaction),
      };
      await params.onFlush(bundle);
    },
    onError: (err, items) => {
      console.error("[reaction-debouncer] flush error:", err);
      if (items.length > 0) {
        const first = items[0];
        const key = `${first.context.sessionKey}:${first.context.messageId}`;
        activeKeys.delete(key);
      }
    },
  });

  return {
    enqueue: (reaction: ReactionEventItem, context: Omit<ReactionBundleContext, "reactions">) =>
      inner.enqueue({ reaction, context }),

    flushKey: async (key: string) => {
      await inner.flushKey(key);
      activeKeys.delete(key);
    },

    drainAllForSession: async (sessionKey: string) => {
      const prefix = `${sessionKey}:`;
      const keysToFlush = Array.from(activeKeys).filter((k) => k.startsWith(prefix));
      await Promise.all(keysToFlush.map((k) => inner.flushKey(k)));
      for (const k of keysToFlush) {
        activeKeys.delete(k);
      }
    },
  };
}
