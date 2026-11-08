/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import {
  contentRows,
  emitTranscriptResize,
  setTranscriptViewport,
} from "./chat-transcript-fixture.test-support.tsx";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
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

it("finishes smooth end preparation after the destination moves beyond the old target", async () => {
  const frame = stubAnimationFrames();
  transcriptDomState.measuredRowHeight = 120;
  const view = await mountFollow("follow-split-destination");
  const { container, transcript, renderRows, rows } = view;
  const host = view.session;
  if (!(host instanceof ChatSessionVirtualizerHost)) {
    throw new Error("Expected the mounted transcript's virtualizer owner");
  }
  const settle = async () => {
    for (let turn = 0; turn < 6; turn++) {
      await Promise.resolve();
      flush();
    }
  };
  const paint = async () => {
    frame();
    await settle();
  };
  const measureMounted = () => {
    for (const row of container.querySelectorAll<HTMLElement>(
      ".chat-virtual-row:not([data-prepared-row])",
    )) {
      emitTranscriptResize(row, 800, 120);
    }
  };
  transcript.scrollToEnd({ behavior: "instant" });
  await settle();
  measureMounted();
  await paint();
  scrollReader(container, 2400);
  renderRows(rows);
  await settle();

  // Native smooth motion can still be travelling when completion splits its row.
  let travelling = true;
  const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object" && !(travelling && options.behavior === "smooth")) {
      container.scrollTop = Math.max(
        0,
        Math.min(options.top ?? container.scrollTop, container.scrollHeight - 600),
      );
    }
  });
  container.scrollTo = scrollTo;
  transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
  await settle();
  measureMounted();
  await paint();
  await paint();
  expect(scrollTo).toHaveBeenCalledWith({ top: 4200, behavior: "smooth" });

  const splitRows = [...rows.slice(0, -1), ...contentRows(20, "split:"), rows.at(-1)!];
  renderRows(splitRows);
  transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
  await settle();
  const destination = requireElement(container, '[data-virtual-row-key="row:39"]');
  destination.style.height = "180px";
  Object.defineProperty(destination, "offsetHeight", { configurable: true, value: 180 });
  // Deliver once: a skipped observer receipt must not need a later external resize.
  for (const row of container.querySelectorAll<HTMLElement>(
    ".chat-virtual-row:not([data-prepared-row])",
  )) {
    emitTranscriptResize(row, 800, row === destination ? 180 : 120);
  }
  travelling = false;
  for (let turn = 0; turn < 6; turn++) {
    await paint();
  }

  expect(transcriptSize(container)).toBe(7260);
  expect(container.scrollTop).toBe(6660);
  expect(host.initialRange.preparingEnd).toBe(false);
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
    await Promise.resolve();
    for (const row of container.querySelectorAll(".chat-virtual-row")) {
      emitTranscriptResize(row, 800, transcriptDomState.measuredRowHeight);
    }
    await Promise.resolve();
    flushFrames();
    await Promise.resolve();
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
