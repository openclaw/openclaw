/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createChatTranscript } from "./chat-transcript-controller.ts";
import { contentRows, emitTranscriptResize } from "./chat-transcript-fixture.test-support.tsx";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  requireElement,
  resetTranscriptTestDom,
  transcriptSize,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it.each([false, true])(
  "defers row resizes without reflecting live geometry (streaming=%s)",
  async (streaming) => {
    const frame = stubAnimationFrames();
    const rows = contentRows(1);
    for (const row of rows) {
      row.streaming = streaming;
    }
    const onViewportResize = vi.fn();
    const transcript = createChatTranscript(() => "resize-delivery", { onViewportResize });
    const { container, renderRows } = await mountTestTranscript(
      "resize-delivery",
      rows,
      transcript,
    );
    frame();
    await flushDeferredRowPrune();
    renderRows(rows);
    emitTranscriptResize(container, 800, 600);
    onViewportResize.mockClear();
    emitTranscriptResize(container, 800, 500);
    expect(onViewportResize).toHaveBeenCalledOnce();
    const row = requireElement(container, ".chat-virtual-row");
    const before = transcriptSize(container);

    emitTranscriptResize(row, 800, 180);
    // A microtask commit still runs inside the browser's resize delivery cycle.
    await flushDeferredRowPrune();
    expect(transcriptSize(container)).toBe(before);

    frame();
    await flushDeferredRowPrune();
    expect(row.dataset.rowSize).toBe(streaming ? undefined : "180");
    expect(row.style.getPropertyValue("contain-intrinsic-block-size")).toBe("");
    if (streaming) {
      expect(row.style.contentVisibility).toBe("visible");
      renderRows(rows.map((item) => Object.assign({}, item, { streaming: false })));
      await flushDeferredRowPrune();
      expect(row.dataset.rowSize).toBe("180");
    }
    expect(transcriptSize(container)).toBe(180);
  },
);

it("defers replacement rows when resize delivery reads a pending native jump", async () => {
  const frame = stubAnimationFrames();
  const rows = contentRows(80);
  const { container, renderRows } = await mountTestTranscript("resize-native-jump", rows);
  frame();
  await flushDeferredRowPrune();
  renderRows(rows);
  container.scrollTop = 800;
  container.dispatchEvent(new Event("scroll"));
  frame();
  await flushDeferredRowPrune();
  const before = transcriptRows(container);
  const outgoing = before[0]!;
  expect(before.length).toBeLessThan(rows.length);
  expect(container.querySelector('.chat-virtual-row[data-index="40"]')).toBeNull();

  // Native scrolling can advance before its scroll event. The outgoing row's
  // observer must not replace its own observed subtree during delivery.
  container.scrollTop = 4000;
  emitTranscriptResize(outgoing, 800, 120);
  expect(transcriptRows(container)).toEqual(before);
  await flushDeferredRowPrune();
  expect(transcriptRows(container)).toEqual(before);

  frame();
  await flushDeferredRowPrune();
  expect(container.scrollTop).toBe(4000);
  expect(container.querySelector('.chat-virtual-row[data-index="40"]')).not.toBeNull();
});
