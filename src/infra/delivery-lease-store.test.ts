import { beforeEach, describe, expect, it } from "vitest";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  registerDeliveryLease,
  lookupDeliveryLease,
  retireDeliveryLease,
  resetDeliveryLeasesForTests,
  getDeliveryLeaseCountForTests,
} from "./delivery-lease-store.js";

function sampleContext(overrides?: Partial<DeliveryContext>): DeliveryContext {
  return {
    channel: "webchat",
    to: "controller",
    accountId: "default",
    threadId: "thread-42",
    ...overrides,
  };
}

describe("delivery-lease-store", () => {
  beforeEach(() => {
    resetDeliveryLeasesForTests();
  });

  describe("register and lookup", () => {
    it("returns the registered context for the session key", () => {
      const ctx = sampleContext();
      registerDeliveryLease("cron:test:run:abc123", ctx);

      const found = lookupDeliveryLease("cron:test:run:abc123");
      expect(found).toEqual(ctx);
    });

    it("overwrites an existing lease on re-registration", () => {
      registerDeliveryLease("sess:key", sampleContext({ channel: "slack" }));
      registerDeliveryLease("sess:key", sampleContext({ channel: "discord" }));

      const found = lookupDeliveryLease("sess:key");
      expect(found?.channel).toBe("discord");
    });
  });

  describe("lookup returns undefined", () => {
    it("for an unknown session key", () => {
      const found = lookupDeliveryLease("nonexistent");
      expect(found).toBeUndefined();
    });

    it("after explicit retirement", () => {
      registerDeliveryLease("sess:key", sampleContext());
      retireDeliveryLease("sess:key");

      const found = lookupDeliveryLease("sess:key");
      expect(found).toBeUndefined();
    });
  });

  describe("retire", () => {
    it("is idempotent", () => {
      retireDeliveryLease("never-registered");
      // Should not throw.
      retireDeliveryLease("never-registered");
    });

    it("removes only the targeted key", () => {
      registerDeliveryLease("a", sampleContext());
      registerDeliveryLease("b", sampleContext());
      retireDeliveryLease("a");

      expect(lookupDeliveryLease("a")).toBeUndefined();
      expect(lookupDeliveryLease("b")).toEqual(sampleContext());
    });
  });

  describe("prune and cap", () => {
    it("evicts oldest entries when cap is exceeded", () => {
      // Register MAX_LEASES + 5 entries.
      const over = 5;
      for (let i = 0; i < 2000 + over; i += 1) {
        registerDeliveryLease(`sess:${i}`, sampleContext());
      }

      // Should have been capped at MAX_LEASES.
      expect(getDeliveryLeaseCountForTests()).toBeLessThanOrEqual(2000);

      // The oldest entries (sess:0 … sess:4) should have been evicted.
      for (let i = 0; i < over; i += 1) {
        expect(lookupDeliveryLease(`sess:${i}`)).toBeUndefined();
      }
    });
  });

  describe("reset", () => {
    it("clears all leases", () => {
      registerDeliveryLease("a", sampleContext());
      registerDeliveryLease("b", sampleContext());
      resetDeliveryLeasesForTests();

      expect(getDeliveryLeaseCountForTests()).toBe(0);
      expect(lookupDeliveryLease("a")).toBeUndefined();
    });
  });
});
