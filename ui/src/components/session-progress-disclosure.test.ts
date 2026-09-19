import { describe, expect, it } from "vitest";
import {
  resolveProgressDisclosure as resolve,
  type ProgressDisclosureEvent,
} from "./session-progress-disclosure.ts";

function mount(manualOpen?: boolean | number) {
  return resolve(undefined, {
    type: "mount",
    open: true,
    manualOpen,
    activeRunId: "run-1",
    completedRunId: null,
    readingHistory: true,
  });
}

function historyScroll(distancePx: number): ProgressDisclosureEvent {
  return { type: "gesture", distancePx };
}

function collapse(state = mount()) {
  return resolve(resolve(resolve(state, historyScroll(160)), historyScroll(160)), {
    type: "settle",
  });
}

describe("progress disclosure transitions", () => {
  it("requires both gesture count and distance, and waits for settlement", () => {
    let state = resolve(mount(), historyScroll(500));
    state = resolve(state, { type: "settle" });
    expect(state.open).toBe(true);
    state = resolve(state, { type: "history", readingHistory: false });
    state = resolve(state, { type: "history", readingHistory: true });
    const firstGesture = resolve(state, historyScroll(159));
    expect(resolve(resolve(firstGesture, historyScroll(160)), { type: "settle" }).open).toBe(true);
    state = resolve(firstGesture, historyScroll(161));
    expect(state.open).toBe(true);
    const beforeSettle = Object.freeze(state);
    state = resolve(beforeSettle, { type: "settle" });
    expect(state.open).toBe(false);
    expect(beforeSettle.open).toBe(true);
    state = resolve(state, { type: "history", readingHistory: false });
    expect(state.open).toBe(false);
  });

  it.each([true, false])(
    "applies a matching completion once, with reading history %s",
    (readingHistory) => {
      let state = collapse();
      state = resolve(state, { type: "history", readingHistory });
      expect(resolve(state, { type: "complete", runId: "older-run" }).open).toBe(false);
      state = resolve(state, { type: "complete", runId: "run-1" });
      expect(state.open).toBe(!readingHistory);
      state = resolve(state, { type: "history", readingHistory: false });
      state = resolve(state, { type: "complete", runId: "run-1" });
      expect(state.open).toBe(!readingHistory);
    },
  );

  it("keeps a manual close through completion, new runs, and later visits", () => {
    let state = resolve(mount(), { type: "click", open: false });
    state = resolve(state, { type: "history", readingHistory: false });
    state = resolve(state, { type: "complete", runId: "run-1" });
    expect(state.open).toBe(false);
    state = resolve(state, { type: "run", runId: "run-2", open: true });
    expect(state.open).toBe(false);
    expect(mount(state.manualOpen).open).toBe(false);
  });

  it("raises the bar after reopening and pins open after the second reopen", () => {
    let state = resolve(collapse(), { type: "click", open: true });
    state = resolve(resolve(state, historyScroll(320)), historyScroll(320));
    state = resolve(state, { type: "settle" });
    expect(state.open).toBe(true);
    state = resolve(state, { type: "history", readingHistory: false });
    state = resolve(state, { type: "history", readingHistory: true });
    const firstTwoGestures = resolve(resolve(state, historyScroll(200)), historyScroll(200));
    expect(resolve(resolve(firstTwoGestures, historyScroll(239)), { type: "settle" }).open).toBe(
      true,
    );
    state = resolve(firstTwoGestures, historyScroll(240));
    state = resolve(state, { type: "settle" });
    expect(state.open).toBe(false);
    expect(state.manualOpen).toBeUndefined();
    state = resolve(state, { type: "click", open: true });
    for (let gesture = 0; gesture < 4; gesture++) {
      state = resolve(state, historyScroll(400));
    }
    state = resolve(state, { type: "settle" });
    expect(state.open).toBe(true);
    expect(collapse(mount(state.manualOpen)).open).toBe(false);
    state = resolve(state, { type: "run", runId: "run-2", open: true });
    expect(state.open).toBe(true);
    expect(collapse(state).open).toBe(false);
  });

  it("preserves initially completed and collapsed defaults without replaying completion", () => {
    let state = resolve(undefined, {
      type: "mount",
      open: false,
      activeRunId: null,
      completedRunId: "run-1",
      readingHistory: false,
    });
    state = resolve(state, { type: "complete", runId: "run-1" });
    expect(state.open).toBe(false);
    state = resolve(state, { type: "run", runId: "run-2", open: false });
    expect(state.open).toBe(false);
    state = resolve(state, { type: "complete", runId: "run-2" });
    expect(state.open).toBe(true);
  });
});

describe("elastic progress disclosure", () => {
  it("retains pixel choices through history and completion, resetting only for a new run", () => {
    let state = resolve(mount(), { type: "extent", extent: 48 });
    state = resolve(state, { type: "history", readingHistory: false });
    state = resolve(state, { type: "complete", runId: "run-1" });
    state = resolve(state, { type: "run", runId: "run-1", open: false });
    expect(state).toMatchObject({ open: true, manualOpen: 48 });
    expect(mount(state.manualOpen).manualOpen).toBe(48);
    state = resolve(state, { type: "run", runId: "run-2", open: false });
    expect(state).toMatchObject({ open: false, manualOpen: undefined });
  });

  it("takes over pending history input and counts a reopen once, not once per frame", () => {
    let state = resolve(resolve(mount(), historyScroll(160)), historyScroll(160));
    state = resolve(state, { type: "takeover" });
    expect(resolve(state, { type: "settle" }).open).toBe(true);
    state = resolve(state, { type: "extent", extent: 0 });
    for (const extent of [1, 20, 48, 32, 80]) {
      state = resolve(state, { type: "extent", extent });
    }
    state = resolve(state, { type: "click", open: true });
    expect(state.manualReopens).toBe(1);
    for (let i = 0; i < 3; i++) {
      state = resolve(state, historyScroll(220));
    }
    state = resolve(state, { type: "settle" });
    expect(state.open).toBe(false);
    state = resolve(state, { type: "extent", extent: 32 });
    for (let i = 0; i < 4; i++) {
      state = resolve(state, historyScroll(400));
    }
    expect(resolve(state, { type: "settle" })).toMatchObject({
      open: true,
      manualOpen: 32,
      manualReopens: 2,
    });
    expect(resolve(state, { type: "clamp", limit: 16 })).toMatchObject({
      manualOpen: 16,
      manualReopens: 2,
    });
  });
});
