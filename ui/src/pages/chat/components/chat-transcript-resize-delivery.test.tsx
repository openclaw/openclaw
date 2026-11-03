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
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("defers resized rows while committing viewport geometry in native delivery", async () => {
  const frame = stubAnimationFrames();
  const rows = contentRows(1);
  const onViewportResize = vi.fn();
  const transcript = createChatTranscript(() => "resize-delivery", { onViewportResize });
  const { container, renderRows } = await mountTestTranscript("resize-delivery", rows, transcript);
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
  expect(row.style.getPropertyValue("contain-intrinsic-block-size")).toBe("180px");
  expect(transcriptSize(container)).toBe(180);
});
