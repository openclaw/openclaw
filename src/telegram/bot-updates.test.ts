import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateOffsetTracker } from "./bot-updates.js";

describe("createTelegramUpdateOffsetTracker", () => {
  it("waits for deferred media-group updates before persisting their offset", () => {
    const onUpdateId = vi.fn();
    const tracker = createTelegramUpdateOffsetTracker({
      initialUpdateId: 100,
      onUpdateId,
    });

    tracker.beginUpdate(101);
    tracker.holdDeferredUpdate(101);
    tracker.endUpdate(101);

    tracker.beginUpdate(102);
    tracker.holdDeferredUpdate(102);
    tracker.endUpdate(102);

    expect(onUpdateId).not.toHaveBeenCalled();
    expect(tracker.shouldSkipUpdate({ update: { update_id: 101 } })).toBe(false);

    tracker.releaseDeferredUpdate(101);

    expect(onUpdateId).toHaveBeenLastCalledWith(101);
    expect(tracker.shouldSkipUpdate({ update: { update_id: 101 } })).toBe(true);
    expect(tracker.shouldSkipUpdate({ update: { update_id: 102 } })).toBe(false);

    tracker.releaseDeferredUpdate(102);

    expect(onUpdateId).toHaveBeenLastCalledWith(102);
    expect(tracker.shouldSkipUpdate({ update: { update_id: 102 } })).toBe(true);
  });

  it("keeps deferred completions behind smaller in-flight updates", () => {
    const onUpdateId = vi.fn();
    const tracker = createTelegramUpdateOffsetTracker({
      initialUpdateId: 100,
      onUpdateId,
    });

    tracker.beginUpdate(150);

    tracker.beginUpdate(200);
    tracker.holdDeferredUpdate(200);
    tracker.endUpdate(200);
    tracker.releaseDeferredUpdate(200);

    const persistedBefore150Completes = onUpdateId.mock.calls.map((call) => Number(call[0]));
    const maxPersistedBefore150Completes =
      persistedBefore150Completes.length > 0
        ? Math.max(...persistedBefore150Completes)
        : Number.NEGATIVE_INFINITY;
    expect(maxPersistedBefore150Completes).toBeLessThan(150);

    tracker.endUpdate(150);

    expect(onUpdateId).toHaveBeenLastCalledWith(200);
    expect(tracker.shouldSkipUpdate({ update: { update_id: 200 } })).toBe(true);
  });
});
