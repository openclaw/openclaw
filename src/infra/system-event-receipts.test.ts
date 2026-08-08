import { beforeEach, expect, it } from "vitest";
import { enqueueSystemEventWithReceipt } from "./system-event-receipts.js";
import * as events from "./system-events.js";

beforeEach(events.resetSystemEventsForTest);

it("removes an exact receipt once while preserving its sibling", () => {
  const options = { sessionKey: " agent:main:test-receipt ", contextKey: "exec:first" };
  const receipt = enqueueSystemEventWithReceipt("first", options);
  expect(receipt).not.toBeNull();
  events.enqueueSystemEvent("sibling", { ...options, contextKey: "exec:sibling" });
  expect(enqueueSystemEventWithReceipt("first", options)).toBeNull();
  expect(receipt?.remove()).toBe(true);
  expect(events.peekSystemEvents("agent:main:test-receipt")).toEqual(["sibling"]);
  expect(receipt?.remove()).toBe(false);
});
