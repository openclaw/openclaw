import { describe, expect, it } from "vitest";
import {
  resolveProgressDisclosure as resolve,
  type ProgressDisclosureState as State,
  type ProgressDisclosureEvent as Event,
} from "./session-progress-disclosure.ts";

function mount(manualOpen?: boolean | number) {
  return resolve(undefined, { type: "mount", open: true, manualOpen, readingHistory: true });
}

function step(state: State, ...events: (Event | number)[]) {
  return events.reduce<State>((current, event) => {
    const next: Event = typeof event === "number" ? { type: "gesture", distancePx: event } : event;
    return resolve(current, next);
  }, state);
}

const settle = { type: "settle" } as const;
const resetHistory = [
  { type: "history", readingHistory: false },
  { type: "history", readingHistory: true },
] as const;

const collapse = (state = mount()) => step(state, 160, 160, settle);

describe("progress disclosure transitions", () => {
  it("requires both gesture count and distance, and waits for settlement", () => {
    let state = step(mount(), 500, settle);
    expect(state.open).toBe(true);
    state = step(state, ...resetHistory);
    const firstGesture = step(state, 159);
    expect(step(firstGesture, 160, settle).open).toBe(true);
    state = step(firstGesture, 161);
    expect(state.open).toBe(true);
    const beforeSettle = Object.freeze(state);
    state = step(beforeSettle, settle);
    expect([beforeSettle.open, state.open]).toEqual([true, false]);
    state = resolve(state, { type: "history", readingHistory: false });
    expect(state.open).toBe(false);
  });

  it("raises the bar after reopening and pins open after the second reopen", () => {
    let state = resolve(collapse(), { type: "click", open: true });
    state = step(state, 320, 320, settle);
    expect(state.open).toBe(true);
    state = step(state, ...resetHistory);
    const firstTwoGestures = step(state, 200, 200);
    expect(step(firstTwoGestures, 239, settle).open).toBe(true);
    state = step(firstTwoGestures, 240, settle);
    expect(state).toMatchObject({ open: false, manualOpen: undefined });
    state = resolve(state, { type: "click", open: true });
    state = step(state, 400, 400, 400, 400, settle);
    expect(state.open).toBe(true);
    expect(collapse(mount(state.manualOpen)).open).toBe(false);
  });
  it("takes over pending history input and counts a reopen once, not once per frame", () => {
    let state = step(mount(), 160, 160, { type: "takeover" });
    expect(step(state, settle).open).toBe(true);
    state = resolve(state, { type: "extent", extent: 0 });
    for (const extent of [1, 20, 48, 32, 80]) {
      state = resolve(state, { type: "extent", extent });
    }
    state = resolve(state, { type: "click", open: true });
    expect(state.manualReopens).toBe(1);
    state = step(state, 220, 220, 220, settle);
    expect(state.open).toBe(false);
    state = resolve(state, { type: "extent", extent: 32 });
    state = step(state, 400, 400, 400, 400);
    expect(step(state, settle)).toMatchObject({ open: true, manualOpen: 32, manualReopens: 2 });
    const clamped = resolve(state, { type: "clamp", limit: 16 });
    expect(clamped).toMatchObject({ manualOpen: 16, manualReopens: 2 });
  });
});
