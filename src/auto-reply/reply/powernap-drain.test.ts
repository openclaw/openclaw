import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAIN_SAFETY_TIMEOUT,
  getDrainedMessageCount,
  getDrainedSources,
  isPowernapDraining,
  recordDrainedMessage,
  setPowernapDraining,
} from "./powernap-drain.js";

describe("powernap-drain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPowernapDraining(false);
  });

  afterEach(() => {
    setPowernapDraining(false);
    vi.useRealTimers();
  });

  it("starts not draining", () => {
    expect(isPowernapDraining()).toBe(false);
  });

  it("can be activated and deactivated", () => {
    setPowernapDraining(true);
    expect(isPowernapDraining()).toBe(true);
    setPowernapDraining(false);
    expect(isPowernapDraining()).toBe(false);
  });

  it("tracks drained message count", () => {
    setPowernapDraining(true);
    expect(getDrainedMessageCount()).toBe(0);
    recordDrainedMessage("user1", "whatsapp");
    recordDrainedMessage("user2", "telegram");
    expect(getDrainedMessageCount()).toBe(2);
  });

  it("resets count on new drain cycle", () => {
    setPowernapDraining(true);
    recordDrainedMessage("user1", "whatsapp");
    expect(getDrainedMessageCount()).toBe(1);

    // Start a new drain cycle
    setPowernapDraining(false);
    setPowernapDraining(true);
    expect(getDrainedMessageCount()).toBe(0);
  });

  it("tracks drained message sources up to limit", () => {
    setPowernapDraining(true);
    for (let i = 0; i < 25; i++) {
      recordDrainedMessage(`user${i}`, "whatsapp");
    }
    // Count tracks all 25
    expect(getDrainedMessageCount()).toBe(25);
    // Sources capped at 20
    expect(getDrainedSources()).toHaveLength(20);
  });

  it("auto-clears drain after safety timeout (60s)", () => {
    setPowernapDraining(true);
    expect(isPowernapDraining()).toBe(true);

    // Advance past safety timeout
    vi.advanceTimersByTime(DRAIN_SAFETY_TIMEOUT + 100);
    expect(isPowernapDraining()).toBe(false);
  });

  it("clears safety timeout when drain is manually cleared", () => {
    setPowernapDraining(true);
    setPowernapDraining(false);
    expect(isPowernapDraining()).toBe(false);

    // Safety timeout should not fire (already cleared)
    vi.advanceTimersByTime(DRAIN_SAFETY_TIMEOUT + 100);
    expect(isPowernapDraining()).toBe(false);
  });
});
