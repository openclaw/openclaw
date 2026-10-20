/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import { contact, mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  type TestContentRow,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

describe("chat transcript controller", () => {
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
      const initial: TestContentRow[] = [
        {
          kind: "content",
          key: "retained-row",
          content: (
            <div
              ref={messageElements.forKey("initial-retained")}
              class="chat-bubble"
              data-message-id="retained"
            >
              retained
            </div>
          ),
        },
      ];
      const next: TestContentRow[] = [
        {
          kind: "content",
          key: "expanded-row",
          content: (
            <>
              <div
                ref={messageElements.forKey("older")}
                class="chat-bubble"
                data-message-id="older"
              >
                older
              </div>
              <div
                ref={messageElements.forKey("expanded-retained")}
                class="chat-bubble"
                data-message-id="retained"
              >
                retained
              </div>
            </>
          ),
        },
      ];
      const { container, session, renderRows } = await mountTestTranscript(
        "touch-map",
        initial,
        transcript,
      );
      try {
        session.syncMessageRows(
          new Map([["retained", "retained-row"]]),
          new Map([["retained", "retained-row"]]),
        );
        renderRows(initial);
        const bubble = expectDefined(container.querySelector(".chat-bubble"), "retained bubble");
        const owned = contact(1, bubble);
        const remaining = outsideContact ? [contact(2, document.body)] : [];
        bubble.dispatchEvent(
          new TouchEvent("touchstart", {
            touches: [...remaining, owned],
            targetTouches: [owned],
            changedTouches: [owned],
            bubbles: true,
          }),
        );
        if (idleBeforeRelease) {
          // The finger can remain down after native offset notifications settle.
          vi.useFakeTimers();
          container.scrollTop = 10;
          container.dispatchEvent(new Event("scroll"));
          await vi.advanceTimersByTimeAsync(200);
        }
        session.syncMessageRows(
          new Map([
            ["older", "expanded-row"],
            ["retained", "expanded-row"],
          ]),
          new Map([
            ["older", "expanded-row"],
            ["retained", "expanded-row"],
          ]),
        );
        renderRows(next);
        expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([
          "retained-row",
        ]);
        expect(container.textContent).not.toContain("older");
        expect(session.activeMessageId(["retained"])).toBe("retained");
        expect(session.activeMessageId(["older"])).toBeNull();
        bubble.dispatchEvent(
          new TouchEvent("touchend", {
            touches: remaining,
            targetTouches: [],
            changedTouches: [owned],
            bubbles: true,
          }),
        );
        renderRows(next);
        expect(transcriptRows(container).map((row) => row.dataset.virtualRowKey)).toEqual([
          "expanded-row",
        ]);
        expect(container.textContent).toContain("older");
        expect(session.activeMessageId(["retained"])).toBe("retained");
        expect(session.activeMessageId(["older"])).toBe("older");
      } finally {
        transcript.dispose();
        if (idleBeforeRelease) {
          vi.useRealTimers();
        }
      }
    },
  );
});
