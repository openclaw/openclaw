import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueAutomationSystemEvent,
  prepareAutomationSystemEvents,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  enqueueSystemEventWithReceipt,
  isSystemEventContextChanged,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

afterEach(resetSystemEventsForTest);
const texts = (sessionKey: string) => peekSystemEventEntries(sessionKey).map(({ text }) => text);
const scheduledOwner = (jobId: string) => ({
  jobId,
  assertCurrent: () => {},
  coalescing: { key: `${jobId}-receiver`, assertCurrent: () => {} },
});
async function consumeScheduled(
  sessionKey: string,
  jobId: string,
  time: number,
  expected: ReturnType<typeof peekSystemEventEntries>,
  remaining: ReturnType<typeof peekSystemEventEntries>,
) {
  const prepared = await prepareAutomationSystemEvents(sessionKey, jobId, time);
  try {
    expect(prepared.events).toEqual(expected);
    prepared.start();
    expect(peekSystemEventEntries(sessionKey)).toEqual(remaining);
  } finally {
    prepared.release();
  }
}

it("refuses overflow without invalidating pending occurrences or removal receipts", () => {
  const sessionKey = "agent:main:capacity";
  const remove = enqueueSystemEventWithReceipt("Exec completed", {
    sessionKey,
    contextKey: "exec:first",
  });
  for (let index = 1; index < 20; index++) {
    expect(
      enqueueSystemEvent(`Reminder ${index}`, { sessionKey, contextKey: `cron:${index}` }),
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
    enqueueSystemEvent("Revised reminder", { sessionKey, contextKey: "cron:19", replace: true }),
  ).toBe(true);
  expect(remove?.()).toBe(true);
  expect(remove?.()).toBe(false);
  expect(enqueueSystemEvent("Admitted after consumption", overflow)).toBe(true);
  expect(consumeSelectedSystemEventEntries(sessionKey, pending).map(({ text }) => text)).toEqual(
    Array.from({ length: 18 }, (_, index) => `Reminder ${index + 1}`),
  );
  expect(texts(sessionKey)).toEqual(["Revised reminder", "Admitted after consumption"]);
});

it("coalesces deferred duplicates only within the same selected scheduled slot", async () => {
  const sessionKey = "agent:main:scheduled-slots";
  const owner = scheduledOwner("receiver");
  const enqueue = (notBeforeRunAtMs: number) =>
    enqueueAutomationSystemEvent("Notice", { sessionKey }, { ...owner, notBeforeRunAtMs });
  expect(enqueue(100)).toBe("queued");
  expect(enqueue(100)).toBe("coalesced");
  expect(enqueue(200)).toBe("queued");
  const original = peekSystemEventEntries(sessionKey);
  await consumeScheduled(sessionKey, owner.jobId, 100, original.slice(0, 1), original.slice(1));
  await consumeScheduled(sessionKey, owner.jobId, 200, original.slice(1), []);
});

it("coalesces an exact duplicate in a full scheduled batch without admitting more text", async () => {
  const sessionKey = "agent:main:bounded-deferred";
  const owner = {
    ...scheduledOwner("one-shot"),
    notBeforeRunAtMs: 100,
  };
  const enqueue = (text: string) => enqueueAutomationSystemEvent(text, { sessionKey }, owner);
  const first = "A".repeat(950);
  const second = "B".repeat(1049);
  expect(enqueue(first)).toBe("queued");
  expect(enqueue(second)).toBe("queued");
  const original = peekSystemEventEntries(sessionKey);
  expect(enqueue(first)).toBe("coalesced");
  expect(() => enqueue("Overflow")).toThrow("prompt limit of 2000 weighted characters");
  expect(peekSystemEventEntries(sessionKey)).toEqual(original);
  await consumeScheduled(sessionKey, owner.jobId, 100, original, []);
});

it("captures only its selected notices before preparation and releases failed admission", async () => {
  const sessionKey = "agent:main:deferred-admission";
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  const release = vi.fn();
  const assertLease = vi.fn();
  const prepare = vi.fn(async () => {
    entered.resolve();
    await resume.promise;
    return { assertCurrent: assertLease, release };
  });
  const first = { jobId: "first", notBeforeRunAtMs: 100, assertCurrent() {}, prepare };
  enqueueAutomationSystemEvent("Captured", { sessionKey }, first);
  enqueueAutomationSystemEvent("Sibling", { sessionKey }, { ...first, jobId: "second" });
  const pending = prepareAutomationSystemEvents(sessionKey, "first", 100);
  await entered.promise;
  enqueueSystemEvent("Captured", { sessionKey });
  enqueueAutomationSystemEvent("Late arrival", { sessionKey }, first);
  resume.resolve();
  const prepared = await pending;
  expect(prepared.events.map((event) => event.text)).toEqual(["Captured"]);
  prepared.release();
  expect(release).toHaveBeenCalledOnce();
  expect(() => prepared.start()).toThrow("preparation was released");
  expect(texts(sessionKey)).toEqual(["Captured", "Sibling", "Captured", "Late arrival"]);
  const retry = await prepareAutomationSystemEvents(sessionKey, "first", 100);
  retry.start();
  expect(texts(sessionKey)).toEqual(["Sibling", "Captured"]);
  expect(release).toHaveBeenCalledTimes(3);
});
