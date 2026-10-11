import { afterEach, expect, it } from "vitest";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  enqueueAutomationSystemEvent,
  prepareAutomationSystemEvents,
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

afterEach(resetSystemEventsForTest);

it("refuses overflow without invalidating pending occurrences or removal receipts", () => {
  const sessionKey = "agent:main:capacity";
  const remove = enqueueSystemEventWithReceipt("Exec completed", {
    sessionKey,
    contextKey: "exec:first",
  });
  for (let index = 1; index < 20; index++) {
    expect(
      enqueueSystemEvent(`Reminder ${index}`, {
        sessionKey,
        contextKey: `cron:${index}`,
      }),
    ).toBe(true);
  }
  const pending = peekSystemEventEntries(sessionKey);
  const overflow = { sessionKey, contextKey: "cron:overflow" };
  expect(enqueueSystemEvent("Unadmitted notice", overflow)).toBe(false);
  expect(enqueueSystemEventEntry("Unadmitted notification", overflow)).toBeNull();
  expect(() => enqueueSystemEventWithReceipt("Unadmitted reminder", overflow)).toThrow(
    "queue is full",
  );
  expect(peekSystemEventEntries(sessionKey)).toEqual(pending);
  expect(isSystemEventContextChanged(sessionKey, "cron:19")).toBe(false);
  expect(enqueueSystemEvent("Reminder 19", { sessionKey, contextKey: "cron:19" })).toBe(false);
  expect(
    enqueueSystemEvent("Revised reminder", {
      sessionKey,
      contextKey: "cron:19",
      replace: true,
    }),
  ).toBe(true);
  expect(remove?.()).toBe(true);
  expect(remove?.()).toBe(false);
  expect(enqueueSystemEvent("Admitted after consumption", overflow)).toBe(true);
  expect(consumeSelectedSystemEventEntries(sessionKey, pending).map(({ text }) => text)).toEqual(
    Array.from({ length: 18 }, (_, index) => `Reminder ${index + 1}`),
  );
  expect(peekSystemEventEntries(sessionKey).map(({ text }) => text)).toEqual([
    "Revised reminder",
    "Admitted after consumption",
  ]);
});

it("coalesces deferred duplicates only within the same selected scheduled slot", async () => {
  const sessionKey = "agent:main:scheduled-slots";
  const owner = {
    jobId: "receiver",
    assertCurrent: () => {},
    coalescing: { key: "same-receiver", assertCurrent: () => {} },
  };
  expect(
    enqueueAutomationSystemEvent("Notice", { sessionKey }, { ...owner, notBeforeRunAtMs: 100 }),
  ).toBe("queued");
  expect(
    enqueueAutomationSystemEvent("Notice", { sessionKey }, { ...owner, notBeforeRunAtMs: 100 }),
  ).toBe("coalesced");
  expect(
    enqueueAutomationSystemEvent("Notice", { sessionKey }, { ...owner, notBeforeRunAtMs: 200 }),
  ).toBe("queued");
  const original = peekSystemEventEntries(sessionKey);
  const first = await prepareAutomationSystemEvents(sessionKey, owner.jobId, 100);
  try {
    expect(first.events).toEqual(original.slice(0, 1));
    first.start();
    expect(peekSystemEventEntries(sessionKey)).toEqual(original.slice(1));
  } finally {
    first.release();
  }
  const second = await prepareAutomationSystemEvents(sessionKey, owner.jobId, 200);
  try {
    expect(second.events).toEqual(original.slice(1));
    second.start();
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  } finally {
    second.release();
  }
});

it("coalesces an exact duplicate in a full scheduled batch without admitting more text", async () => {
  const sessionKey = "agent:main:bounded-deferred";
  const owner = {
    jobId: "one-shot",
    notBeforeRunAtMs: 100,
    assertCurrent: () => {},
    coalescing: { key: "one-shot-receiver", assertCurrent: () => {} },
  };
  const first = "A".repeat(950);
  const second = "B".repeat(1049);
  expect(enqueueAutomationSystemEvent(first, { sessionKey }, owner)).toBe("queued");
  expect(enqueueAutomationSystemEvent(second, { sessionKey }, owner)).toBe("queued");
  const original = peekSystemEventEntries(sessionKey);
  expect(enqueueAutomationSystemEvent(first, { sessionKey }, owner)).toBe("coalesced");
  expect(() => enqueueAutomationSystemEvent("Overflow", { sessionKey }, owner)).toThrow(
    "prompt limit of 2000 weighted characters",
  );
  expect(peekSystemEventEntries(sessionKey)).toEqual(original);
  const prepared = await prepareAutomationSystemEvents(sessionKey, owner.jobId, 100);
  try {
    expect(prepared.events).toEqual(original);
    prepared.start();
    expect(peekSystemEventEntries(sessionKey)).toEqual([]);
  } finally {
    prepared.release();
  }
});
