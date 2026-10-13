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
  });
});

describe("elastic progress disclosure", () => {
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
