/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import {
  contact,
  mountTestTranscript,
  mountChatThread,
} from "../test-helpers/chat-transcript-native.tsx";
import {
  installTranscriptDomMocks,
  flushDeferredRowPrune,
  requireElement,
  threadProps,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([
  { idleBeforeRelease: false, outsideContact: false },
  { idleBeforeRelease: true, outsideContact: false },
  { idleBeforeRelease: true, outsideContact: true },
])(
  "keeps the committed rows and message lookup together while a touch holds a prepend, idle=$idleBeforeRelease, outside contact=$outsideContact",
  async ({ idleBeforeRelease, outsideContact }) => {
    const transcript = createTestTranscript("touch-map");
    const refs = transcript.renderSession(
      "agent:main:touch-map",
      (session) => session.messageElements,
    );
    const contentRows = (key: string, ids: string[]): TestContentRow[] => [
      {
        kind: "content",
        key,
        content: ids.map((id) => (
          <div ref={refs.forKey(`${key}-${id}`)} class="chat-bubble" data-message-id={id}>
            {id}
          </div>
        )),
      },
    ];
    const syncRows = (key: string, ids: string[]) => {
      const rows = new Map(ids.map((id) => [id, key]));
      session.syncMessageRows(rows, rows);
    };
    const initial = contentRows("retained-row", ["retained"]);
    const next = contentRows("expanded-row", ["older", "retained"]);
    const { container, session, renderRows } = await mountTestTranscript(
      "touch-map",
      initial,
      transcript,
    );
    const expectRows = (older: string | null) => {
      expect(container.textContent?.includes("older")).toBe(older !== null);
      expect(["retained", "older"].map((id) => session.activeMessageId([id]))).toEqual([
        "retained",
        older,
      ]);
    };
    try {
      syncRows("retained-row", ["retained"]);
      renderRows(initial);
      const bubble = expectDefined(container.querySelector(".chat-bubble"), "retained bubble");
      const owned = contact(1, bubble);
      const remaining = outsideContact ? [contact(2, document.body)] : [];
      const touch = (type: string, touches: Touch[]) =>
        bubble.dispatchEvent(
          new TouchEvent(type, { touches, changedTouches: [owned], bubbles: true }),
        );
      touch("touchstart", [...remaining, owned]);
      if (idleBeforeRelease) {
        // The finger can remain down after native offset notifications settle.
        vi.useFakeTimers();
        container.scrollTop = 10;
        container.dispatchEvent(new Event("scroll"));
        await vi.advanceTimersByTimeAsync(200);
      }
      syncRows("expanded-row", ["older", "retained"]);
      renderRows(next);
      expectRows(null);
      touch("touchend", remaining);
      renderRows(next);
      expectRows("older");
    } finally {
      transcript.dispose();
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "holds a real call/result regrouping during touch, shared source key=%s",
  async (sharedSourceKey) => {
    const transcript = createTestTranscript("touch-regroup");
    const result = {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Saved file contents" }],
      __openclaw: { id: "result", seq: 2 },
    };
    const answer = {
      role: "assistant",
      content: "The retained answer",
      __openclaw: { id: "answer", seq: 3 },
    };
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "older.md" } }],
      __openclaw: { id: sharedSourceKey ? "result" : "call", seq: 1 },
    };
    const container = document.body.appendChild(document.createElement("div"));
    const view = mountChatThread(container, transcript);
    const props = threadProps("touch-regroup", "agent:main:touch-regroup", [result, answer], {
      showToolCalls: true,
    });
    try {
      view.render(props);
      await flushDeferredRowPrune();
      const bubble = requireElement(container, '.chat-bubble[data-entry-id="answer"]');
      const owned = contact(1, bubble);
      bubble.dispatchEvent(
        new TouchEvent("touchstart", {
          touches: [owned],
          changedTouches: [owned],
          bubbles: true,
        }),
      );
      props.messages = [call, result, answer];
      view.render(props);
      expect(container.textContent).not.toContain("older.md");
      expect(bubble.isConnected).toBe(true);
      bubble.dispatchEvent(
        new TouchEvent("touchend", {
          touches: [],
          changedTouches: [owned],
          bubbles: true,
        }),
      );
      view.render(props);
      await flushDeferredRowPrune();
      expect(container.textContent).toContain("older.md");
      expect(container.textContent).toContain("The retained answer");
    } finally {
      view.unmount();
      transcript.dispose();
    }
  },
);
