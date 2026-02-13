import { afterEach, describe, expect, it } from "vitest";
import {
  getInFlightCount,
  getInFlightRequests,
  resetTracker,
  trackMessageEnd,
  trackMessageStart,
  waitForInFlightCompletion,
} from "./in-flight-tracker.js";

afterEach(() => {
  resetTracker();
});

describe("trackMessageStart / trackMessageEnd", () => {
  it("increments count on start", () => {
    expect(getInFlightCount()).toBe(0);
    trackMessageStart({ chatId: "-100", channel: "telegram" });
    expect(getInFlightCount()).toBe(1);
  });

  it("decrements count on end", () => {
    const id = trackMessageStart({ chatId: "-100", channel: "telegram" });
    expect(getInFlightCount()).toBe(1);
    trackMessageEnd(id);
    expect(getInFlightCount()).toBe(0);
  });

  it("handles multiple concurrent requests", () => {
    const id1 = trackMessageStart({ chatId: "-100", channel: "telegram" });
    const id2 = trackMessageStart({ chatId: "-200", channel: "line" });
    const id3 = trackMessageStart({ chatId: "-300", channel: "discord" });
    expect(getInFlightCount()).toBe(3);

    trackMessageEnd(id2);
    expect(getInFlightCount()).toBe(2);

    trackMessageEnd(id1);
    trackMessageEnd(id3);
    expect(getInFlightCount()).toBe(0);
  });

  it("ignores unknown request id on end", () => {
    trackMessageStart({ chatId: "-100", channel: "telegram" });
    trackMessageEnd("nonexistent-id");
    expect(getInFlightCount()).toBe(1);
  });

  it("truncates message preview to 50 chars", () => {
    const longMessage = "a".repeat(100);
    trackMessageStart({ chatId: "-100", channel: "telegram", messagePreview: longMessage });
    const requests = getInFlightRequests();
    expect(requests[0].messagePreview.length).toBeLessThanOrEqual(50);
  });

  it("uses default preview when not provided", () => {
    trackMessageStart({ chatId: "-100", channel: "telegram" });
    const requests = getInFlightRequests();
    expect(requests[0].messagePreview).toBe("(no preview)");
  });
});

describe("getInFlightRequests", () => {
  it("returns all in-flight request details", () => {
    trackMessageStart({ chatId: "-100", channel: "telegram", messagePreview: "hello" });
    trackMessageStart({ chatId: "-200", channel: "line", messagePreview: "world" });
    const requests = getInFlightRequests();
    expect(requests).toHaveLength(2);
  });

  it("returns empty array when no requests", () => {
    expect(getInFlightRequests()).toEqual([]);
  });
});

describe("waitForInFlightCompletion", () => {
  it("resolves immediately when no in-flight requests", async () => {
    const result = await waitForInFlightCompletion();
    expect(result.completed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("resolves when all requests complete before timeout", async () => {
    const id = trackMessageStart({ chatId: "-100", channel: "telegram" });
    const promise = waitForInFlightCompletion(5000);

    setTimeout(() => trackMessageEnd(id), 50);

    const result = await promise;
    expect(result.completed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("times out when requests do not complete", async () => {
    trackMessageStart({ chatId: "-100", channel: "telegram" });
    const result = await waitForInFlightCompletion(100);
    expect(result.timedOut).toBe(true);
    expect(result.remaining).toBe(1);
  });
});

describe("resetTracker", () => {
  it("clears all state", () => {
    trackMessageStart({ chatId: "-100", channel: "telegram" });
    trackMessageStart({ chatId: "-200", channel: "line" });
    expect(getInFlightCount()).toBe(2);
    resetTracker();
    expect(getInFlightCount()).toBe(0);
  });
});
