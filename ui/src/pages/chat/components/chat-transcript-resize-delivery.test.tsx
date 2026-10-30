/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it } from "vitest";
import { stubAnimationFrames } from "../chat-view.test-helpers.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
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

it("commits a resized row after native observer delivery, retaining its measured height", async () => {
  const frame = stubAnimationFrames();
  const rows = contentRows(1);
  const { container, renderRows } = await mountTestTranscript("resize-delivery", rows);
  frame();
  await flushDeferredRowPrune();
  renderRows(rows);
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
