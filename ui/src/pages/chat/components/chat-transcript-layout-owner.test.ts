// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  footprintLayout,
  mountedVirtualizer,
  phases,
  scheduledCallbacks,
} from "./chat-transcript-layout.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("transcript layout callbacks", () => {
  it.each(phases)("ignores an obsolete $label after reconnecting", (phase) => {
    const scheduled = scheduledCallbacks(phase.idle);
    const { layout, writeRows } = footprintLayout();
    const old = mountedVirtualizer(layout);
    layout.persistRows(old.instance, false);
    if (phase.advance) {
      scheduled.takeFrame()();
    }
    const obsolete = phase.advance && phase.idle ? scheduled.takeIdle() : scheduled.takeFrame();
    layout.disconnect();
    old.dispose();
    const current = mountedVirtualizer(layout, 250);
    try {
      layout.persistRows(current.instance, false);
      expect(scheduled.frames.size).toBe(1);
      obsolete();
      layout.persistRows(current.instance, false);
      expect(scheduled.frames.size).toBe(1);
      expect(scheduled.idleCallbacks.size).toBe(0);
      scheduled.takeFrame()();
      (phase.idle ? scheduled.takeIdle() : scheduled.takeFrame())();
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(Object.values(writeRows.mock.calls[0]![0])).toEqual([250]);
      expect(layout.rowMinimum(0)).toBe(300);
    } finally {
      layout.disconnect();
      current.dispose();
    }
  });
});
