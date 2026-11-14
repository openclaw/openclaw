import { expect, it } from "vitest";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";
import {
  projectTranscriptChain,
  projectTranscriptIndex,
} from "./components/chat-transcript-message-index.ts";

it("shares one weak table for normalized messages, tool cards, and row revisions", () => {
  let serializations = 0;
  const message = {
    role: "user",
    content: "Keep this source message.",
    timestamp: 10,
    __openclaw: { id: "derived-cache-source", seq: 1 },
    metadata: {
      toJSON: () => {
        serializations++;
        return { label: "Settled history" };
      },
    },
  };
  const sessionKey = "agent:main:derived-cache";
  // Warm grouping and extraction outside the count; their independent caches
  // are not part of the three-owner storage contract.
  const chain = projectTranscriptChain(
    buildChatItems(createProps({ sessionKey, messages: [message] })),
    { sessionKey, runWorking: false, searchActive: false },
  );
  const normalized = normalizeMessage(message);
  const cards = extractToolCardsCached(message);
  serializations = 0;

  const tables = new Set<object>();
  // oxlint-disable-next-line typescript/unbound-method -- Rebound to the actual map with call below.
  const originalGet = WeakMap.prototype.get;
  // oxlint-disable-next-line no-extend-native -- Count synchronous owner reads only; restore in finally.
  Object.defineProperty(WeakMap.prototype, "get", {
    value(this: WeakMap<object, unknown>, key: object) {
      if (key === message) {
        tables.add(this);
      }
      return originalGet.call(this, key);
    },
  });
  try {
    expect(normalizeMessage(message)).toBe(normalized);
    expect(extractToolCardsCached(message)).toBe(cards);
    const index = projectTranscriptIndex(chain, new Map(), {
      assistantName: "Assistant",
      userId: "reader",
      userName: "Reader",
    });
    expect(index.loadedReplySources.get("derived-cache-source")?.message).toBe(message);
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]).toMatchObject({ kind: "item", revision: expect.any(String) });
    // Proves messageRevision ran; a cached/streaming row could otherwise let
    // a one-table assertion pass without exercising the third owner.
    expect(serializations).toBe(1);
    expect(tables.size).toBe(1);
  } finally {
    // oxlint-disable-next-line no-extend-native -- Restore the original method before leaving the test.
    Object.defineProperty(WeakMap.prototype, "get", { value: originalGet });
  }
});
