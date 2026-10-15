import { afterEach, expect, it, vi } from "vitest";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { scheduleFollowupDrain } from "./drain.js";
import { enqueueFollowupRun, hasPendingSteerFollowupFrom } from "./enqueue.js";
import { admitFollowupRunLifecycle } from "./lifecycle.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

let sequence = 0;
let key = "latest-steer-fallback-0";
afterEach(() => {
  clearFollowupQueue(key);
  key = `latest-steer-fallback-${++sequence}`;
  vi.useRealTimers();
});
const createRun = (prompt: string) =>
  createQueueTestRun({
    prompt,
    messageId: prompt,
    originatingChannel: "whatsapp",
    originatingTo: "owner",
    originatingAccountId: "default",
  });

it("collects both corrections into one later turn instead of answering each stale version", async () => {
  vi.useFakeTimers();
  const calls: FollowupRun[] = [];
  const callback = async (run: FollowupRun) => {
    calls.push(run);
  };
  const settings = createQueueSettings({ mode: "steer" });
  enqueueFollowupRun(key, createRun("first correction"), settings, "message-id", callback, false);
  enqueueFollowupRun(key, createRun("second correction"), settings, "message-id", callback, false);
  scheduleFollowupDrain(key, callback);
  await vi.runAllTimersAsync();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.prompt).toContain("first correction");
  expect(calls[0]?.prompt).toContain("second correction");
});

it.each([
  "same",
  "different-sender",
  "different-thread",
  "cancelled",
  "inflight",
  "internal",
  "followup",
])("withholds only a retained steer successor from the same owner and route: %s", (scenario) => {
  const active = createRun("original");
  const pending = createRun("correction");
  const controller = new AbortController();
  if (scenario === "different-sender") {
    pending.run.senderId = "other";
  }
  if (scenario === "different-thread") {
    pending.originatingThreadId = "other";
  }
  if (scenario === "cancelled") {
    pending.abortSignal = controller.signal;
    controller.abort();
  }
  if (scenario === "internal") {
    pending.run.inputProvenance = { kind: "internal_system" };
  }
  enqueueFollowupRun(
    key,
    pending,
    createQueueSettings({ mode: scenario === "followup" ? "followup" : "steer" }),
    "message-id",
    undefined,
    false,
  );
  if (scenario === "inflight") {
    getExistingFollowupQueue(key)?.inFlight.add(pending);
  }
  expect(hasPendingSteerFollowupFrom(key, active)).toBe(scenario === "same");
});

it("sees an owner correction behind an unrelated pending event", () => {
  const internal = createRun("internal event");
  internal.run.inputProvenance = { kind: "internal_system" };
  enqueueFollowupRun(
    key,
    internal,
    createQueueSettings({ mode: "steer" }),
    "message-id",
    undefined,
    false,
  );
  enqueueFollowupRun(
    key,
    createRun("correction"),
    createQueueSettings({ mode: "steer" }),
    "message-id",
    undefined,
    false,
  );
  expect(hasPendingSteerFollowupFrom(key, createRun("original"))).toBe(true);
});

it("keeps separate WhatsApp ingress adoption owners while withholding interim stale replies", async () => {
  vi.useFakeTimers();
  const first = createRun("first correction");
  const second = createRun("second correction");
  for (const source of [first, second]) {
    source.turnAdoptionLifecycle = {
      admission: "exclusive",
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
  }
  const calls: FollowupRun[] = [];
  const visible: string[] = [];
  const callback = async (run: FollowupRun) => {
    await admitFollowupRunLifecycle(run);
    calls.push(run);
    if (!hasPendingSteerFollowupFrom(key, run)) {
      visible.push(run.prompt);
    }
  };
  const settings = createQueueSettings({ mode: "steer" });
  enqueueFollowupRun(key, first, settings, "message-id", callback, false);
  enqueueFollowupRun(key, second, settings, "message-id", callback, false);
  scheduleFollowupDrain(key, callback);
  await vi.runAllTimersAsync();
  expect(calls).toHaveLength(2);
  expect(calls[0]?.prompt).toContain("first correction");
  expect(calls[0]?.prompt).not.toContain("second correction");
  expect(calls[1]?.prompt).toBe("second correction");
  expect(first.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledOnce();
  expect(second.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledOnce();
  expect(visible).toEqual(["second correction"]);
});
