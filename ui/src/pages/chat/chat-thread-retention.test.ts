// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { buildItems } from "./chat-thread.test-support.ts";
import {
  getExpandedToolCards,
  resetChatThreadState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";

describe("tool expansion state", () => {
  it("releases a closed pane's messages while retaining its disclosure choices", async () => {
    resetChatThreadState();
    class TranscriptMessage {
      role = "assistant";
      content = [{ type: "toolcall", id: "released-call", name: "read" }];
    }
    const paneId = "released-pane";
    const sessionKey = "released-session";
    const populatePane = () => {
      const message = new TranscriptMessage();
      const items = buildItems({ paneId, sessionKey, messages: [message] });
      syncToolCardExpansionState(sessionKey, items, true);
      return {
        messageReference: new WeakRef(message),
        collectionControl: new WeakRef({ unowned: true }),
      };
    };
    try {
      const { messageReference, collectionControl } = populatePane();
      await collectGarbageForTest();
      expect(collectionControl.deref()).toBeUndefined();
      expect(messageReference.deref() !== undefined).toBe(true);

      resetChatThreadState(paneId);
      await collectGarbageForTest();
      expect(messageReference.deref()).toBeUndefined();
      expect([...getExpandedToolCards(sessionKey).values()]).toEqual([true]);
    } finally {
      resetChatThreadState();
    }
  });
});
