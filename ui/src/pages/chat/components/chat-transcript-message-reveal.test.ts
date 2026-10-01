/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("chat transcript controller", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each(["none", "idle at end", "wheel", "touch", "disconnect", "new reveal"] as const)(
    "keeps only the current deferred message reveal after %s",
    async (interruption) => {
      const update = createDeferred<boolean>();
      const transcript = new ChatTranscriptController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: vi.fn(),
          updateComplete: update.promise,
        },
        () => `message-reveal-${interruption}`,
      );
      const rows: TestContentRow[] = ["first", "second"].map((id) => ({
        kind: "content",
        key: id,
        content: html`<div class="chat-bubble" data-entry-id=${id}>${id}</div>`,
      }));
      const { container, session, renderRows } = await mountTestTranscript(
        `reveal-${interruption}`,
        rows,
        transcript,
      );
      try {
        Object.defineProperties(container, {
          clientHeight: { configurable: true, value: 600 },
          scrollHeight: { configurable: true, value: interruption === "idle at end" ? 600 : 2000 },
        });
        const scrollTo = vi.fn();
        container.scrollTo = scrollTo;
        const bubbles = [...container.querySelectorAll<HTMLElement>(".chat-bubble")];
        session.syncMessageRows(
          new Map([
            ["first", "first"],
            ["second", "second"],
          ]),
          new Map([
            ["first", "first"],
            ["second", "second"],
          ]),
        );
        renderRows(rows);
        if (interruption === "idle at end") {
          vi.useFakeTimers();
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
          transcript.hostDisconnected();
        }
        update.resolve(true);
        await update.promise;
        expect(bubbles[0]?.classList.contains("chat-bubble--reply-target")).toBe(
          ["none", "idle at end"].includes(interruption),
        );
        expect(bubbles[1]?.classList.contains("chat-bubble--reply-target")).toBe(
          interruption === "new reveal",
        );
      } finally {
        transcript.hostDisconnected();
        vi.useRealTimers();
      }
    },
  );
});
