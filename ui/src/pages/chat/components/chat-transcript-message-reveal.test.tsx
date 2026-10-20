/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { setTranscriptViewport } from "./chat-transcript-fixture.test-support.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

let flushFrames: () => void;
beforeEach(() => {
  installTranscriptDomMocks();
  flushFrames = stubAnimationFrames();
});
afterEach(resetTranscriptTestDom);

async function commitLayout() {
  flush();
  await Promise.resolve();
  flushFrames();
  flush();
}

function replyRows(transcript: ReturnType<typeof createChatTranscript>, sessionKey: string) {
  const elements = transcript.renderSession(sessionKey, (session) => session.messageElements);
  return (key: string, ref = key): TestContentRow => ({
    kind: "content",
    key,
    content: (
      <div ref={elements.forKey(ref)} class="chat-bubble" data-entry-id={key}>
        {key}
      </div>
    ),
  });
}

const rowMap = (...keys: string[]) => new Map(keys.map((key) => [key, key]));

it("retains a projected reply target until its row commits and prevents automatic follow from taking over", async () => {
  const transcript = createChatTranscript(() => "projected-reply");
  const row = replyRows(transcript, "agent:main:projected-reply");
  const tail = row("tail");
  const original = row("original", "optimistic-original");
  const { container, session, renderRows } = await mountTestTranscript(
    "projected-reply",
    [tail],
    transcript,
  );
  try {
    session.syncMessageRows(rowMap("original", "tail"), new Map());
    expect(transcript.revealMessage("unknown")).toBe(false);
    expect(transcript.revealMessage("original")).toBe(true);
    expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
    await Promise.resolve();
    await commitLayout();
    expect(container.querySelector('[data-entry-id="original"]')).toBeNull();

    renderRows([original, tail]);
    await commitLayout();
    expect(
      container.querySelector('[data-entry-id="original"].chat-bubble--reply-target'),
    ).not.toBeNull();
  } finally {
    transcript.dispose();
  }
});

it.each(["none", "idle at end", "wheel", "touch", "disconnect", "new reveal"] as const)(
  "keeps only the current deferred message reveal after %s",
  async (interruption) => {
    const transcript = createChatTranscript(() => `message-reveal-${interruption}`);
    const row = replyRows(transcript, `agent:main:reveal-${interruption}`);
    const rows = [row("first"), row("second")];
    const { container, session, renderRows } = await mountTestTranscript(
      `reveal-${interruption}`,
      rows,
      transcript,
    );
    try {
      setTranscriptViewport(container, interruption === "idle at end" ? 600 : 2000);
      const scrollTo = vi.fn();
      container.scrollTo = scrollTo;
      const bubbles = [...container.querySelectorAll<HTMLElement>(".chat-bubble")];
      session.syncMessageRows(rowMap("first", "second"), rowMap("first", "second"));
      renderRows(rows);
      if (interruption === "idle at end") {
        vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
      }
      expect(transcript.revealMessage("first")).toBe(true);
      scrollTo.mockClear();
      if (interruption === "wheel") {
        container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        expect.soft(scrollTo).toHaveBeenCalledExactlyOnceWith({
          top: container.scrollTop,
          behavior: "instant",
        });
      } else if (interruption === "idle at end") {
        container.dispatchEvent(new Event("scroll"));
        vi.advanceTimersByTime(150);
      } else if (interruption === "new reveal") {
        expect(transcript.revealMessage("second")).toBe(true);
      } else if (interruption === "touch") {
        container.dispatchEvent(new TouchEvent("touchstart"));
      } else if (interruption === "disconnect") {
        transcript.dispose();
      }
      await Promise.resolve();
      await commitLayout();
      expect(
        bubbles.map((bubble) => bubble.classList.contains("chat-bubble--reply-target")),
      ).toEqual([["none", "idle at end"].includes(interruption), interruption === "new reveal"]);
    } finally {
      transcript.dispose();
      vi.useRealTimers();
    }
  },
);
