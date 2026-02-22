import { describe, expect, it, vi } from "vitest";
import { createUpdateOffsetWatermark } from "./update-offset-watermark.js";

describe("createUpdateOffsetWatermark", () => {
  it("should not advance offset past incomplete lower update IDs (race condition regression)", () => {
    // Regression test: When updates are processed concurrently and a higher update_id
    // completes before a lower one, the offset should NOT jump ahead.
    // Previously, the offset tracked MAX completed update_id, which could skip
    // lower-numbered in-flight updates on crash/restart.

    const onPersist = vi.fn();
    const wm = createUpdateOffsetWatermark(null, onPersist);

    // Batch: update 100 (voice, chat A) and update 101 (text, chat B) start concurrently
    wm.markStarted(100);
    wm.markStarted(101);

    // Update 101 finishes first (text is fast)
    wm.markCompleted(101);

    // Offset should NOT advance to 101 because 100 is still in-flight
    expect(onPersist).not.toHaveBeenCalled();
    expect(wm.getCurrentOffset()).toBeNull();

    // Update 100 finishes (voice processing done)
    wm.markCompleted(100);

    // NOW offset should advance to 101 (both 100 and 101 are complete)
    expect(onPersist).toHaveBeenCalledWith(101);
    expect(wm.getCurrentOffset()).toBe(101);
  });

  it("should advance offset immediately when updates complete in order", () => {
    const onPersist = vi.fn();
    const wm = createUpdateOffsetWatermark(null, onPersist);

    wm.markStarted(100);
    wm.markCompleted(100);
    expect(onPersist).toHaveBeenCalledWith(100);

    wm.markStarted(101);
    wm.markCompleted(101);
    expect(onPersist).toHaveBeenCalledWith(101);
  });

  it("should respect initial offset and not regress", () => {
    const onPersist = vi.fn();
    const wm = createUpdateOffsetWatermark(99, onPersist);

    wm.markStarted(100);
    wm.markStarted(101);
    wm.markCompleted(101);
    expect(onPersist).not.toHaveBeenCalled();

    wm.markCompleted(100);
    expect(onPersist).toHaveBeenCalledWith(101);
    expect(wm.getCurrentOffset()).toBe(101);
  });

  it("should handle gaps in update IDs", () => {
    const onPersist = vi.fn();
    const wm = createUpdateOffsetWatermark(99, onPersist);

    // Telegram can skip update IDs
    wm.markStarted(100);
    wm.markStarted(105);

    wm.markCompleted(100);
    // Advances to 100 only (105 still in-flight, and 101-104 were never seen)
    expect(onPersist).toHaveBeenCalledWith(100);

    wm.markCompleted(105);
    // Now 105 completes, but 101-104 were never started — they advance through
    expect(onPersist).toHaveBeenCalledWith(105);
  });
});
