/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { makeChatHost } from "../chat-host.test-support.ts";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { lockChatScroll } from "../scroll.ts";
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

function mockScroll(container: HTMLElement, notify = false) {
  return (container.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object" && options.top !== undefined) {
      const previous = container.scrollTop;
      container.scrollTop = options.top;
      if (notify && previous !== container.scrollTop) {
        container.dispatchEvent(new Event("scroll"));
      }
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

it.each(["none", "wheel", "programmatic"] as const)(
  "keeps measured growth after a no-op smooth follow, reader departure=%s",
  async (departure) => {
    const flushFrames = stubAnimationFrames();
    transcriptDomState.measuredRowHeight = 120;
    let followEnabled = true;
    const { container, transcript, session, renderRows, rows } = await mountFollow(
      "smooth-no-op",
      40,
      {
        canFollowEnd: () => followEnabled,
        onReaderScroll: () => {
          followEnabled = false;
        },
      },
    );
    let scrollHeight = 4800;
    setTranscriptViewport(container, () => scrollHeight);
    const scrollTo = mockScroll(container, true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    session.setContentReady(true);
    scrollReader(container, 4200);
    renderRows(rows);
    await vi.advanceTimersByTimeAsync(150);
    flushFrames();
    renderRows(rows);
    flushFrames();
    scrollTo.mockClear();

    transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
    flushFrames();
    expect(scrollTo.mock.calls).toEqual([
      [{ top: 4200, behavior: "smooth" }],
      [{ top: 4200, behavior: "instant" }],
    ]);
    if (departure === "wheel") {
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    }
    if (departure !== "none") {
      scrollReader(container, container.scrollTop - 100);
    }
    const readerOffset = container.scrollTop;
    const lastRow = requireElement(container, '[data-virtual-row-key="row:39"]');
    lastRow.style.height = "155px";
    emitTranscriptResize(lastRow, 800, 155);
    scrollHeight += 35;
    renderRows(rows);
    flushFrames();
    expect(container.scrollTop).toBe(departure === "none" ? 4235 : readerOffset);
    expect(followEnabled).toBe(departure !== "wheel");
  },
);

it.each([
  ["auto", false],
  ["manual", false],
  ["manual", true],
] as const)(
  "allows reader takeover after retargeting %s follow (settled=%s)",
  async (source, settled) => {
    stubAnimationFrames();
    const policy = makeChatHost({ chatHasAutoScrolled: true });
    const { container, transcript } = await mountFollow("follow-continuity", 40, {
      canFollowEnd: () => !policy.chatFollowLocked,
    });
    Object.assign(policy, { chatCancelScroll: () => transcript.cancelScroll() });
    setTranscriptViewport(container, 4800);
    container.scrollTop = 1000;
    const writes: ScrollToOptions[] = [];
    container.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") {
        writes.push(options);
      }
    };
    transcript.scrollToEnd({ source, behavior: "smooth" });
    expect(writes.some((write) => write.behavior === "smooth")).toBe(true);
    writes.length = 0;
    transcript.scrollToEnd({ source: "auto", behavior: "smooth" });
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((write) => write.behavior === "smooth")).toBe(true);
    if (settled) {
      container.scrollTop = 4200;
    }
    writes.length = 0;
    lockChatScroll(policy);
    expect(policy.chatFollowLocked).toBe(true);
    expect(writes).toEqual([
      expect.objectContaining({ behavior: "instant", top: settled ? 4200 : 1000 }),
    ]);
  },
);
it.each([
  [0, true, false],
  [8, true, false],
  [50, true, false],
  [0, false, false],
  [8, false, false],
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
