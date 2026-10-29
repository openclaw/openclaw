import { describe, expect, it } from "vitest";
import { handleNavigationClick, shouldHandleNavigationClick } from "./navigation-click.ts";

function clickEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as MouseEvent;
}

const nativeBehaviorCases = [
  ["a prevented click", { defaultPrevented: true }],
  ["a non-primary click", { button: 1 }],
  ["a Meta-modified click", { metaKey: true }],
  ["a Control-modified click", { ctrlKey: true }],
  ["a Shift-modified click", { shiftKey: true }],
  ["an Alt-modified click", { altKey: true }],
] satisfies Array<[string, Partial<MouseEvent>]>;

describe("shouldHandleNavigationClick", () => {
  it("handles an ordinary primary click", () => {
    expect(shouldHandleNavigationClick(clickEvent())).toBe(true);
  });

  it.each(nativeBehaviorCases)("preserves native behavior for %s", (_, event) => {
    expect(shouldHandleNavigationClick(clickEvent(event))).toBe(false);
  });
});

describe("handleNavigationClick", () => {
  it("prevents native navigation before running the action once", () => {
    const calls: string[] = [];
    handleNavigationClick(clickEvent({ preventDefault: () => calls.push("prevent") }), () => {
      calls.push("navigate");
    });
    expect(calls).toEqual(["prevent", "navigate"]);
  });

  it.each(nativeBehaviorCases)("leaves %s untouched", (_, overrides) => {
    const calls: string[] = [];
    handleNavigationClick(
      clickEvent({ ...overrides, preventDefault: () => calls.push("prevent") }),
      () => calls.push("navigate"),
    );
    expect(calls).toEqual([]);
  });
});
