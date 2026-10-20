import { describe, expect, it } from "vitest";
import {
  resolveProgressDisclosure as resolve,
  type ProgressDisclosureState,
} from "./session-progress-disclosure.ts";

function mount(manualOpen?: boolean | number) {
  return resolve(undefined, { type: "mount", open: true, manualOpen, readingHistory: true });
}

function gestures(state: ProgressDisclosureState, ...distances: number[]) {
  return distances.reduce(
    (previous, distancePx) => resolve(previous, { type: "gesture", distancePx }),
    state,
  );
}

function settle(state: ProgressDisclosureState) {
  return resolve(state, { type: "settle" });
}

function resetHistory(state: ProgressDisclosureState) {
  return resolve(resolve(state, { type: "history", readingHistory: false }), {
    type: "history",
    readingHistory: true,
  });
}

function collapse(state = mount()) {
  return settle(gestures(state, 160, 160));
}

describe("progress disclosure transitions", () => {
  it("requires both gesture count and distance, and waits for settlement", () => {
    let state = settle(gestures(mount(), 500));
    expect(state.open).toBe(true);
    state = resetHistory(state);
    const firstGesture = gestures(state, 159);
    expect(settle(gestures(firstGesture, 160)).open).toBe(true);
    state = gestures(firstGesture, 161);
    expect(state.open).toBe(true);
    const beforeSettle = Object.freeze(state);
    state = settle(beforeSettle);
    expect(state.open).toBe(false);
    expect(beforeSettle.open).toBe(true);
    state = resolve(state, { type: "history", readingHistory: false });
    expect(state.open).toBe(false);
  });

  it("raises the bar after reopening and pins open after the second reopen", () => {
    let state = resolve(collapse(), { type: "click", open: true });
    state = settle(gestures(state, 320, 320));
    expect(state.open).toBe(true);
    state = resetHistory(state);
    const firstTwoGestures = gestures(state, 200, 200);
    expect(settle(gestures(firstTwoGestures, 239)).open).toBe(true);
    state = settle(gestures(firstTwoGestures, 240));
    expect(state.open).toBe(false);
    expect(state.manualOpen).toBeUndefined();
    state = resolve(state, { type: "click", open: true });
    state = settle(gestures(state, 400, 400, 400, 400));
    expect(state.open).toBe(true);
    expect(collapse(mount(state.manualOpen)).open).toBe(false);
  });
});

describe("elastic progress disclosure", () => {
  it("takes over pending history input and counts a reopen once, not once per frame", () => {
    let state = gestures(mount(), 160, 160);
    state = resolve(state, { type: "takeover" });
    expect(settle(state).open).toBe(true);
    state = resolve(state, { type: "extent", extent: 0 });
    for (const extent of [1, 20, 48, 32, 80]) {
      state = resolve(state, { type: "extent", extent });
    }
    state = resolve(state, { type: "click", open: true });
    expect(state.manualReopens).toBe(1);
    state = settle(gestures(state, 220, 220, 220));
    expect(state.open).toBe(false);
    state = resolve(state, { type: "extent", extent: 32 });
    state = gestures(state, 400, 400, 400, 400);
    expect(settle(state)).toMatchObject({
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
