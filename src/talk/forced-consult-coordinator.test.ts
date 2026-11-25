import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRealtimeVoiceForcedConsultCoordinator as createCoordinator } from "./forced-consult-coordinator.js";

let coordinator: ReturnType<typeof createCoordinator>;
const question = "check status";
const prepare = (text = question, id = "forced-1") => coordinator.prepare(text, { id })!;
function schedule(text = question, id = "forced-1") {
  const handle = prepare(text, id);
  const run = vi.fn();
  coordinator.schedule(handle, 200, run);
  return { handle, run };
}
beforeEach(() => {
  vi.useFakeTimers();
  coordinator = createCoordinator();
});
afterEach(() => {
  vi.useRealTimers();
});

it("lets a native consult cancel a pending forced consult", () => {
  const { handle, run } = schedule();
  expect(handle).toBeDefined();
  expect(coordinator.recordNativeConsult({ question }, "native-call")).toMatchObject({
    kind: "pending",
    handle: { id: "forced-1" },
  });
  vi.advanceTimersByTime(250);
  expect(run).not.toHaveBeenCalled();
  expect(coordinator.hasRecent(question)).toBe(true);
  vi.advanceTimersByTime(2_001);
  expect(coordinator.hasRecent(question)).toBe(false);
});

it.each([false, true])("dedupes cancellation after delivery=%s", (delivered) => {
  const handle = prepare();
  coordinator.markStarted(handle);
  if (delivered) {
    coordinator.markDelivered(handle);
  }
  coordinator.markCancelled(handle);
  expect(coordinator.isCancelled(handle)).toBe(!delivered);
  expect(coordinator.recordNativeConsult({ question }, "native-call")).toMatchObject({
    kind: "already_delivered",
    handle: { id: "forced-1" },
  });
  expect(coordinator.nativeCallIds(handle)).toEqual(["native-call"]);
  if (!delivered) {
    vi.advanceTimersByTime(2_001);
    expect(coordinator.isCancelled(handle)).toBe(false);
    expect(coordinator.recordNativeConsult({ question })).toMatchObject({ kind: "none" });
  }
});

it("tracks native-first consults during the dedupe window", () => {
  expect(coordinator.recordNativeConsult({ question })).toMatchObject({ kind: "none", question });
  expect(coordinator.hasRecentNativeConsult(question)).toBe(true);
  expect(coordinator.hasRecentNativeConsult("restart server")).toBe(false);
  vi.advanceTimersByTime(2_001);
  expect(coordinator.hasRecentNativeConsult(question)).toBe(false);
});

it("can treat native consults without a readable question as recent", () => {
  coordinator.recordNativeConsult({ prompt: "   " });
  expect(coordinator.hasRecentNativeConsult(question)).toBe(false);
  expect(coordinator.hasRecentNativeConsult(question, { allowUnknownQuestion: true })).toBe(true);
});

it.each(["clear", "clearPending"] as const)("%s cancels pending timers", (method) => {
  const active = prepare("active question", "active");
  coordinator.markStarted(active);
  const { run } = schedule();
  coordinator[method]();
  vi.advanceTimersByTime(250);
  expect(run).not.toHaveBeenCalled();
  expect(coordinator.hasRecent(question)).toBe(false);
  expect(coordinator.hasRecent("active question")).toBe(method === "clearPending");
});

it("matches remembered question aliases", () => {
  const handle = prepare("check server status");
  coordinator.rememberQuestion(handle, "Please inspect the server health");
  expect(coordinator.findRecent("inspect server health")).toEqual(handle);
  expect(coordinator.hasRecent("check server status")).toBe(true);
});

it("consumes the only pending handle while delivered handles are retained", () => {
  const delivered = prepare("delivered question", "delivered");
  coordinator.markStarted(delivered);
  coordinator.markDelivered(delivered);
  const pending = prepare("pending question", "pending");
  expect(coordinator.consumePending()).toEqual(pending);
});

it("clears an existing timer when an explicit handle id is reused", () => {
  const stale = schedule("first question", "call-1");
  const current = schedule("second question", "call-1");
  vi.advanceTimersByTime(250);
  expect(stale.run).not.toHaveBeenCalled();
  expect(current.run).toHaveBeenCalledWith(current.handle);
});
