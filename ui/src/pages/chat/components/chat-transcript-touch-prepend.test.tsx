/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import type { JSX } from "@solidjs/web";
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
    const messageElements = transcript.renderSession(
      "agent:main:touch-map",
      (session) => session.messageElements,
    );
    const contentRows = (key: string, content: JSX.Element): TestContentRow[] => [
      { kind: "content", key, content },
    ];
    const message = (ref: string, id: string) => (
      <div ref={messageElements.forKey(ref)} class="chat-bubble" data-message-id={id}>
        {id}
      </div>
    );
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
    const initial = contentRows("retained-row", message("initial-retained", "retained"));
    const next = contentRows(
      "expanded-row",
      <>
        {message("older", "older")}
        {message("expanded-retained", "retained")}
      </>,
    );
    const { container, session, renderRows } = await mountTestTranscript(
      "touch-map",
      initial,
      transcript,
    );
    const expectRows = (key: string) =>
      expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([key]);
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
      expectRows("retained-row");
      expect(container.textContent).not.toContain("older");
      expect([session.activeMessageId(["retained"]), session.activeMessageId(["older"])]).toEqual([
        "retained",
        null,
      ]);
      touch("touchend", bubble, remaining, [owned]);
      renderRows(next);
      expectRows("expanded-row");
      expect(container.textContent).toContain("older");
      expect([session.activeMessageId(["retained"]), session.activeMessageId(["older"])]).toEqual([
        "retained",
        "older",
      ]);
    } finally {
      transcript.dispose();
      if (idleBeforeRelease) {
        vi.useRealTimers();
      }
    }
  },
);
