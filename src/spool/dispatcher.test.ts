import { describe, it, expect } from "vitest";
import { isEventExpired, hasExceededRetries } from "./dispatcher.js";
import { buildSpoolEvent } from "./writer.js";

describe("spool dispatcher helpers", () => {
  describe("isEventExpired", () => {
    it("should return false when no expiresAt", () => {
      const event = buildSpoolEvent({
        version: 1,
        payload: { kind: "agentTurn", message: "Test" },
      });
      expect(isEventExpired(event)).toBe(false);
    });

    it("should return false when expiresAt is in the future", () => {
      const futureDate = new Date(Date.now() + 60_000).toISOString();
      const event = buildSpoolEvent({
        version: 1,
        expiresAt: futureDate,
        payload: { kind: "agentTurn", message: "Test" },
      });
      expect(isEventExpired(event)).toBe(false);
    });

    it("should return true when expiresAt is in the past", () => {
      const pastDate = new Date(Date.now() - 60_000).toISOString();
      const event = buildSpoolEvent({
        version: 1,
        expiresAt: pastDate,
        payload: { kind: "agentTurn", message: "Test" },
      });
      expect(isEventExpired(event)).toBe(true);
    });
  });

  describe("hasExceededRetries", () => {
    it("should return false when retryCount is 0", () => {
      const event = buildSpoolEvent({
        version: 1,
        payload: { kind: "agentTurn", message: "Test" },
      });
      expect(hasExceededRetries(event)).toBe(false);
    });

    it("should return false when retryCount is below maxRetries", () => {
      const event = buildSpoolEvent({
        version: 1,
        maxRetries: 5,
        payload: { kind: "agentTurn", message: "Test" },
      });
      event.retryCount = 2;
      expect(hasExceededRetries(event)).toBe(false);
    });

    it("should return false when retryCount equals maxRetries (allows final retry)", () => {
      const event = buildSpoolEvent({
        version: 1,
        maxRetries: 3,
        payload: { kind: "agentTurn", message: "Test" },
      });
      event.retryCount = 3;
      // With maxRetries=3, we allow: initial + 3 retries = 4 total attempts
      // So retryCount=3 means 3 failures, one more retry allowed
      expect(hasExceededRetries(event)).toBe(false);
    });

    it("should return true when retryCount exceeds maxRetries", () => {
      const event = buildSpoolEvent({
        version: 1,
        maxRetries: 3,
        payload: { kind: "agentTurn", message: "Test" },
      });
      event.retryCount = 5;
      expect(hasExceededRetries(event)).toBe(true);
    });

    it("should use default maxRetries (3) when not specified", () => {
      const event = buildSpoolEvent({
        version: 1,
        payload: { kind: "agentTurn", message: "Test" },
      });
      event.retryCount = 2;
      expect(hasExceededRetries(event)).toBe(false);

      event.retryCount = 3;
      // With default maxRetries=3, retryCount=3 means 3 failures, one more allowed
      expect(hasExceededRetries(event)).toBe(false);

      event.retryCount = 4;
      // Now exceeded: 4 > 3
      expect(hasExceededRetries(event)).toBe(true);
    });

    it("should allow first attempt when maxRetries is 0", () => {
      const event = buildSpoolEvent({
        version: 1,
        maxRetries: 0,
        payload: { kind: "agentTurn", message: "Test" },
      });
      // retryCount=0 means no failures yet, should allow initial execution
      expect(hasExceededRetries(event)).toBe(false);

      event.retryCount = 1;
      // After first failure, no retries allowed (maxRetries=0)
      expect(hasExceededRetries(event)).toBe(true);
    });

    it("should use configMaxRetries when event.maxRetries is not set", () => {
      const event = buildSpoolEvent({
        version: 1,
        payload: { kind: "agentTurn", message: "Test" },
      });
      // No event.maxRetries, config says maxRetries=5
      event.retryCount = 4;
      expect(hasExceededRetries(event, 5)).toBe(false);

      event.retryCount = 5;
      expect(hasExceededRetries(event, 5)).toBe(false); // equals, still allowed

      event.retryCount = 6;
      expect(hasExceededRetries(event, 5)).toBe(true); // exceeded
    });

    it("should prefer event.maxRetries over configMaxRetries", () => {
      const event = buildSpoolEvent({
        version: 1,
        maxRetries: 2, // Event says 2
        payload: { kind: "agentTurn", message: "Test" },
      });
      // Config says 10, but event says 2 - event wins
      event.retryCount = 3;
      expect(hasExceededRetries(event, 10)).toBe(true); // 3 > 2
    });
  });
});
