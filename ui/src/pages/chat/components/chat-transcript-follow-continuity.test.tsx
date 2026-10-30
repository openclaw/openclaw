/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  contentRows,
  emitTranscriptResize,
  setTranscriptViewport,
} from "./chat-transcript-fixture.test-support.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  requireElement,
  transcriptDomState,
  transcriptSize,
} from "./chat-transcript.test-support.ts";

function scrollReader(container: HTMLElement, top: number) {
  container.scrollTop = top;
  container.dispatchEvent(new Event("scroll"));
}

function mockScroll(container: HTMLElement) {
  return (container.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object" && options.top !== undefined) {
      container.scrollTop = options.top;
    }
  }));
}

const mounted: ReturnType<typeof createChatTranscript>[] = [];
async function mountFollow(
  id: string,
  count = 40,
  options?: Parameters<typeof createChatTranscript>[1],
  ownerId = id,
) {
  const rows = contentRows(count);
  const transcript = createChatTranscript(() => ownerId, options);
  const fixture = await mountTestTranscript(id, rows, transcript);
  mounted.push(fixture.transcript);
  return { ...fixture, rows };
}
beforeEach(installTranscriptDomMocks);
afterEach(() => {
  mounted.splice(0).forEach((transcript) => transcript.dispose());
  vi.useRealTimers();
  resetTranscriptTestDom();
});

it("remeasures skipped rows when automatic follow replaces smooth scrolling", async () => {
  const flushFrames = stubAnimationFrames();
  transcriptDomState.measuredRowHeight = 120;
  const { container, transcript, renderRows, rows } = await mountFollow("follow-remeasure");
  setTranscriptViewport(container, 4800);
  scrollReader(container, 2400);
  renderRows(rows);
  await flushDeferredRowPrune();
  renderRows(rows);
  const row = requireElement(container, ".chat-virtual-row");
  const before = transcriptSize(container);
  container.scrollTo = vi.fn();
  transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
  row.style.height = "180px";
  // TanStack suppresses ResizeObserver deliveries outside the smooth target's buffer.
  emitTranscriptResize(row, 800, 180);
  renderRows(rows);
  expect(transcriptSize(container)).toBe(before);

  transcript.scrollToEnd({ source: "auto", behavior: "auto" });
  flushFrames();
  renderRows(rows);
  expect(transcriptSize(container)).toBe(before + 60);
});

it.each([
  [0, true, false],
  [8, true, false],
  [0, false, false],
  [0, true, true],
] as const)(
  "follows typing growth only from the resting end (distance=%s, follow=%s, pending=%s)",
  async (distance, followEnabled, nativePending) => {
    const flushFrames = stubAnimationFrames();
    const { container, renderRows, rows } = await mountFollow(
      `typing-distance-${distance}`,
      12,
      { canFollowEnd: () => followEnabled },
      `typing-distance-${distance}-${followEnabled}`,
    );
    const padding = nativePending ? 88 : 84;
    let scrollHeight = transcriptSize(container) + padding;
    setTranscriptViewport(container, () => scrollHeight);
    emitTranscriptResize(container, 800, 600);
    scrollReader(container, 0);
    renderRows(rows);
    await flushDeferredRowPrune();
    renderRows(rows);
    flushFrames();
    const total = transcriptSize(container);
    scrollHeight = total + padding;
    scrollReader(container, container.scrollHeight - container.clientHeight - distance);
    if (nativePending) {
      // Native movement can precede the offset observer.
      container.scrollTop -= 100;
    }
    const readerOffset = container.scrollTop;
    const scrollTo = mockScroll(container);
    renderRows([...rows, { kind: "content", key: "presence:typing", content: <div>Typing</div> }]);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(container.scrollTop).toBe(readerOffset);
    scrollHeight += 100;
    flushFrames();
    expect(container.scrollTop).toBe(
      distance === 0 && followEnabled && !nativePending ? readerOffset + 100 : readerOffset,
    );
    if (nativePending) {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      expect(scrollTo).not.toHaveBeenCalled();
      scrollReader(container, container.scrollTop - 100);
      scrollTo.mockClear();
      setTranscriptViewport(container, total + 188);
      flushFrames();
      expect(scrollTo).not.toHaveBeenCalled();
      expect(container.scrollTop).toBe(readerOffset - 100);
    }
  },
);
