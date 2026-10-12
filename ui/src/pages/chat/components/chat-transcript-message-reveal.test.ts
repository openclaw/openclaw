/* @vitest-environment jsdom */

import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import {
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

describe("chat transcript controller", () => {
  let flushFrames: () => void;
  beforeEach(() => {
    installTranscriptDomMocks();
    flushFrames = stubAnimationFrames();
  });
  afterEach(resetTranscriptTestDom);

  function commitLayout() {
    flush();
    flushFrames();
    flush();
  }

  it("retains a projected reply target until its row commits and prevents automatic follow from taking over", async () => {
    const update = createDeferred<boolean>();
    const transcript = new ChatTranscriptController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: update.promise,
      },
      () => "projected-reply",
    );
    const tail: TestContentRow = {
      kind: "content",
      key: "tail",
      content: html`<div class="chat-bubble" data-entry-id="tail">Tail</div>`,
    };
    const original: TestContentRow = {
      kind: "content",
      key: "original",
      content: html`<div class="chat-bubble" data-entry-id="original">Original</div>`,
    };
    const { container, session, renderRows } = await mountTestTranscript(
      "projected-reply",
      [tail],
      transcript,
    );
    try {
      session.syncMessageRows(
        new Map([
          ["original", "original"],
          ["tail", "tail"],
        ]),
        new Map(),
      );
      expect(transcript.revealMessage("unknown")).toBe(false);
      expect(transcript.revealMessage("original")).toBe(true);
      expect(transcript.scrollToEnd({ source: "auto" })).toBe(false);
      update.resolve(true);
      await update.promise;
      commitLayout();
      expect(container.querySelector('[data-entry-id="original"]')).toBeNull();

      renderRows([original, tail]);
      commitLayout();
      expect(
        container
          .querySelector('[data-entry-id="original"]')
          ?.classList.contains("chat-bubble--reply-target"),
      ).toBe(true);
    } finally {
      transcript.hostDisconnected();
    }
  });

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
          transcript.hostDisconnected();
        }
        update.resolve(true);
        await update.promise;
        commitLayout();
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
