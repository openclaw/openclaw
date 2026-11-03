/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { contact, mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import {
  installTranscriptDomMocks,
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
