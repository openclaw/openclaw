/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript, render } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { contentRows, emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import {
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  threadProps,
  transcriptDomState,
} from "./chat-transcript.test-support.ts";

const cleanups: (() => void)[] = [];

beforeEach(() => {
  installTranscriptDomMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it.each(["row growth", "viewport resize"] as const)(
  "skips eager end reads and retains a locked reader's end after %s",
  async (geometryChange) => {
    const flushFrames = stubAnimationFrames();
    transcriptDomState.measuredRowHeight = 1000;
    const rows = contentRows(1, "long-row:", "Long transcript row");
    const onReaderScroll = vi.fn();
    const paneId = `end-scheduling-${geometryChange.replaceAll(" ", "-")}`;
    const transcript = createChatTranscript(() => paneId, {
      canFollowEnd: () => false,
      onReaderScroll,
    });
    cleanups.push(transcript.dispose);
    // The shared mount waits for its zero-delay row-pruning task.
    const mounting = mountTestTranscript(paneId, rows, transcript);
    await vi.advanceTimersByTimeAsync(0);
    const { container, renderRows, session } = await mounting;
    cleanups.push(() => {
      render(null, container);
      container.remove();
    });
    let contentHeight = 1000;
    let viewportHeight = 400;
    const readContentHeight = vi.fn(() => contentHeight);
    Object.defineProperties(container, {
      clientHeight: { configurable: true, get: () => viewportHeight },
      scrollHeight: { configurable: true, get: readContentHeight },
    });
    // Native clamping does not invoke the JavaScript getter being counted.
    container.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      const offset = typeof options === "number" ? (y ?? 0) : (options?.top ?? container.scrollTop);
      container.scrollTop = Math.max(0, Math.min(offset, contentHeight - viewportHeight));
    };
    const commitFrame = async () => {
      renderRows(rows);
      await Promise.resolve();
      flush();
      flushFrames();
      await Promise.resolve();
      flush();
    };
    session.layout.configureRows(
      threadProps(paneId, "agent:main:end-scheduling", []),
      "gutter",
      false,
    );
    emitTranscriptResize(container, 800, viewportHeight);
    emitTranscriptResize(requireElement(container, ".chat-virtual-row"), 800, contentHeight);
    await commitFrame();
    await commitFrame();
    container.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    // Retire the native scrolling state and its already-queued reconciliation.
    await vi.advanceTimersByTimeAsync(150);
    await commitFrame();
    await commitFrame();

    const invalidated = vi.fn();
    cleanups.push(transcript.subscribe(invalidated));
    container.scrollTop = 200;
    container.dispatchEvent(new Event("scroll"));
    // Settled reader motion updates its window without a caller render.
    expect(invalidated).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(200);
    // Required reads in the native observer are outside this deferred-work count.
    readContentHeight.mockClear();
    flushFrames();
    expect(readContentHeight).not.toHaveBeenCalled();

    if (geometryChange === "row growth") {
      contentHeight = 1100;
      transcriptDomState.measuredRowHeight = contentHeight;
      emitTranscriptResize(requireElement(container, ".chat-virtual-row"), 800, contentHeight);
    } else {
      viewportHeight = 300;
      emitTranscriptResize(container, 800, viewportHeight);
    }
    // Geometry changes below this stationary reader emit no native offset event.
    renderRows(rows);
    readContentHeight.mockClear();
    // Drain committed row effects without releasing the queued animation frame.
    await vi.advanceTimersByTimeAsync(0);
    flush();
    await vi.advanceTimersByTimeAsync(0);
    expect.soft(readContentHeight).not.toHaveBeenCalled();
    await commitFrame();
    await commitFrame();
    expect(container.scrollTop).toBe(200);
    expect(contentHeight - viewportHeight).toBe(700);
    onReaderScroll.mockClear();

    publishTranscriptScroll(container, { type: "composer-input" });
    container.scrollTop = 700;
    viewportHeight -= 100;
    // The capture listener commits editor geometry before the offset observer.
    container.dispatchEvent(new Event("scroll"));
    expect(container.scrollTop).toBe(800);
    expect(onReaderScroll).toHaveBeenCalledExactlyOnceWith(true);
  },
);
