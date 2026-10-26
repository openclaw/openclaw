/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { contact, mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  type TestContentRow,
  transcriptRows,
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
    const touch = (type: string, bubble: Element, touches: Touch[], changed: Touch[]) =>
      bubble.dispatchEvent(
        new TouchEvent(type, {
          touches,
          targetTouches: type === "touchstart" ? changed : [],
          changedTouches: changed,
          bubbles: true,
        }),
      );
    const initial = contentRows("retained-row", ["retained"]);
    const next = contentRows("expanded-row", ["older", "retained"]);
    const { container, session, renderRows } = await mountTestTranscript(
      "touch-map",
      initial,
      transcript,
    );
    const expectRows = (key: string, older: string | null) => {
      expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([key]);
      expect(container.textContent?.includes("older")).toBe(older !== null);
      expect([session.activeMessageId(["retained"]), session.activeMessageId(["older"])]).toEqual([
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
      touch("touchstart", bubble, [...remaining, owned], [owned]);
      if (idleBeforeRelease) {
        // The finger can remain down after native offset notifications settle.
        vi.useFakeTimers();
        container.scrollTop = 10;
        container.dispatchEvent(new Event("scroll"));
        await vi.advanceTimersByTimeAsync(200);
      }
      syncRows("expanded-row", ["older", "retained"]);
      renderRows(next);
      expectRows("retained-row", null);
      touch("touchend", bubble, remaining, [owned]);
      renderRows(next);
      expectRows("expanded-row", "older");
    } finally {
      transcript.dispose();
      if (idleBeforeRelease) {
        vi.useRealTimers();
      }
    }
  },
);
