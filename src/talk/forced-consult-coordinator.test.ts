import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealtimeVoiceForcedConsultCoordinator } from "./forced-consult-coordinator.js";

let coordinator: ReturnType<typeof createRealtimeVoiceForcedConsultCoordinator>;
const question = "Can you check this?";
function prepare(text = question, id = "forced-1") {
  return coordinator.prepare(text, { id })!;
}
beforeEach(() => {
  vi.useFakeTimers();
  coordinator = createRealtimeVoiceForcedConsultCoordinator();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("realtime voice forced consult coordinator", () => {
  it("runs a delayed pending consult unless a native consult arrives first", () => {
    const run = vi.fn();
    const pending = prepare();
    expect(pending).toBeDefined();
    coordinator.schedule(pending, 200, run);
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

  it("does not retroactively cancel a delivered handle", () => {
    const handle = prepare();
    coordinator.markStarted(handle);
    coordinator.markDelivered(handle);
    coordinator.markCancelled(handle);
    expect(coordinator.isCancelled(handle)).toBe(false);
    expect(coordinator.recordNativeConsult({ question }, "native-call")).toMatchObject({
      kind: "already_delivered",
      handle: { id: "forced-1" },
    });
  });

  it("tracks native-first consults during the dedupe window", () => {
    expect(coordinator.recordNativeConsult({ question: "check server" })).toMatchObject({
      kind: "none",
      question: "check server",
    });
    expect(coordinator.hasRecentNativeConsult("check server")).toBe(true);
    expect(coordinator.hasRecentNativeConsult("restart server")).toBe(false);
    vi.advanceTimersByTime(2_001);
    expect(coordinator.hasRecentNativeConsult("check server")).toBe(false);
  });

  it("can treat native consults without a readable question as recent", () => {
    coordinator.recordNativeConsult({ prompt: "   " });
    expect(coordinator.hasRecentNativeConsult("check status")).toBe(false);
    expect(coordinator.hasRecentNativeConsult("check status", { allowUnknownQuestion: true })).toBe(
      true,
    );
  });

  it("clears pending, active, and cleanup timers", () => {
    const run = vi.fn();
    const pending = prepare("check status", "forced-1");
    coordinator.schedule(pending, 200, run);
    coordinator.clear();
    vi.advanceTimersByTime(250);
    expect(run).not.toHaveBeenCalled();
    expect(coordinator.hasRecent("check status")).toBe(false);
  });

  it("clears only pending handles", () => {
    const pendingRun = vi.fn();
    const active = prepare("active question", "active");
    const pending = prepare("pending question", "pending");
    coordinator.markStarted(active);
    coordinator.schedule(pending, 200, pendingRun);
    coordinator.clearPending();
    vi.advanceTimersByTime(250);
    expect(pendingRun).not.toHaveBeenCalled();
    expect(coordinator.hasRecent("pending question")).toBe(false);
    expect(coordinator.hasRecent("active question")).toBe(true);
  });

  it("matches remembered question aliases", () => {
    const handle = prepare("check server status", "forced-1");
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
    const staleRun = vi.fn();
    const currentRun = vi.fn();
    const stale = prepare("first question", "call-1");
    coordinator.schedule(stale, 200, staleRun);

    const current = prepare("second question", "call-1");
    coordinator.schedule(current, 200, currentRun);
    vi.advanceTimersByTime(250);
    expect(staleRun).not.toHaveBeenCalled();
    expect(currentRun).toHaveBeenCalledWith(current);
  });

  it("matches cancelled handles until the dedupe window expires", () => {
    const pending = prepare("check status", "forced-1");
    coordinator.markStarted(pending);
    coordinator.markCancelled(pending);
    expect(coordinator.isCancelled(pending)).toBe(true);
    expect(
      coordinator.recordNativeConsult({ question: "check status" }, "native-call"),
    ).toMatchObject({ kind: "already_delivered", handle: { id: "forced-1" } });
    expect(coordinator.nativeCallIds(pending)).toEqual(["native-call"]);
    vi.advanceTimersByTime(2_001);
    expect(coordinator.isCancelled(pending)).toBe(false);
    expect(coordinator.recordNativeConsult({ question: "check status" })).toMatchObject({
      kind: "none",
    });
  });
});
