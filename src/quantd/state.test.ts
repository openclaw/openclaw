import { describe, expect, it } from "vitest";
import { createQuantdStateStore } from "./state.js";

describe("quantd state", () => {
  it("replays duplicate ids without allocating a new record", () => {
    const store = createQuantdStateStore();

    const first = store.prepareEvent("market_event", {
      eventId: "evt-1",
      symbol: "EURUSD",
      signal: "enter_long",
    });

    expect(first.duplicate).toBe(false);
    if (first.duplicate || !first.record) {
      throw new Error("expected first record");
    }

    store.commitRecord(first.record);

    const duplicate = store.prepareEvent("market_event", {
      eventId: "evt-1",
      symbol: "EURUSD",
      signal: "enter_long",
    });

    expect(duplicate).toEqual({
      duplicate: true,
      existingSequence: 1,
    });
    expect(store.snapshot().metrics.duplicateEvents).toBe(1);
  });

  it("marks health degraded when heartbeat becomes stale", () => {
    let now = 1_000;
    const store = createQuantdStateStore({
      now: () => now,
      heartbeatStaleAfterMs: 250,
    });

    const heartbeat = store.prepareEvent("heartbeat", {
      eventId: "hb-1",
      source: "gateway",
    });
    if (heartbeat.duplicate || !heartbeat.record) {
      throw new Error("expected heartbeat record");
    }
    store.commitRecord(heartbeat.record);

    expect(store.snapshot().health).toMatchObject({
      status: "ok",
      reasons: [],
    });

    now += 400;

    expect(store.snapshot().health).toMatchObject({
      status: "degraded",
      reasons: ["heartbeat_stale"],
    });
  });
});
