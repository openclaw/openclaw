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

const rowMap = (...keys: string[]) => new Map(keys.map((key) => [key, key]));

it.each([
  "projection",
  "none",
  "idle at end",
  "wheel",
  "touch",
  "disconnect",
  "new reveal",
] as const)("retains only the current deferred reply target after %s", async (interruption) => {
  const projected = interruption === "projection";
  const paneId = projected ? "projected-reply" : `reveal-${interruption}`;
  const transcript = createChatTranscript(() => paneId);
  const refs = transcript.renderSession(
    `agent:main:${paneId}`,
    (session) => session.messageElements,
  );
  const row = (key: string, ref = key): TestContentRow => ({
    kind: "content",
    key,
    content: <div ref={refs.forKey(ref)} class="chat-bubble" data-entry-id={key} />,
  });
  const rows = [row("first", projected ? "optimistic-first" : "first"), row("second")];
  const { container, session, renderRows } = await mountTestTranscript(
    paneId,
    projected ? [rows[1]!] : rows,
    transcript,
  );
  try {
    setTranscriptViewport(container, interruption === "idle at end" ? 600 : 2000);
    session.syncMessageRows(
      rowMap("first", "second"),
      projected ? new Map() : rowMap("first", "second"),
    );
    if (!projected) {
      renderRows(rows);
    }
    let bubbles = [...container.querySelectorAll(".chat-bubble")];
    if (interruption === "idle at end") {
      vi.useFakeTimers({ toNotFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
    }
    if (projected) {
      expect(transcript.revealMessage("unknown")).toBe(false);
    }
    expect(transcript.revealMessage("first")).toBe(true);
    if (projected) {
      expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
      await Promise.resolve();
      await commitLayout();
      expect(container.querySelector('[data-entry-id="first"]')).toBeNull();
      renderRows(rows);
      bubbles = [...container.querySelectorAll(".chat-bubble")];
    } else if (interruption === "wheel") {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
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
    expect(bubbles.map((bubble) => bubble.classList.contains("chat-bubble--reply-target"))).toEqual(
      [["projection", "none", "idle at end"].includes(interruption), interruption === "new reveal"],
    );
  } finally {
    transcript.dispose();
    vi.useRealTimers();
  }
});
