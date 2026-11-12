/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { TranscriptHistoryInput } from "./chat-scroll-input.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function inputFixture(target?: HTMLElement) {
  const root = document.body.appendChild(document.createElement("div"));
  const input = new TranscriptHistoryInput();
  const directions: number[] = [];
  for (const type of ["wheel", "keydown", "touchstart", "touchmove", "touchend", "touchcancel"]) {
    root.addEventListener(type, (event) => directions.push(input.readBoundaryDirection(event, 0)));
  }
  if (target) {
    root.append(target);
  }
  return {
    root,
    input,
    read: (event: Event) => {
      (target ?? root).dispatchEvent(event);
      return directions.at(-1);
    },
  };
}

it.each([
  { deltaY: 100, expected: 1 },
  { deltaY: -100, expected: -1 },
  { deltaY: 0, expected: 0 },
  { deltaY: 1, deltaX: 100, expected: 0 },
  { deltaY: 100, ctrlKey: true, expected: 0 },
  { deltaY: 100, metaKey: true, expected: 0 },
  { deltaY: 100, altKey: true, expected: 0 },
  { deltaY: 100, shiftKey: true, expected: 0 },
])("classifies a wheel only when the transcript owns its vertical direction: %j", (init) => {
  const { read } = inputFixture();
  expect(read(new WheelEvent("wheel", { ...init, bubbles: true }))).toBe(init.expected);
});

it("leaves prevented and native-control wheel input with its owner", () => {
  const { read } = inputFixture(document.createElement("input"));
  expect(read(new WheelEvent("wheel", { deltaY: 100, bubbles: true }))).toBe(0);
  const direct = inputFixture();
  const prevented = new WheelEvent("wheel", { deltaY: 100, bubbles: true, cancelable: true });
  prevented.preventDefault();
  expect(direct.read(prevented)).toBe(0);
});

it("chains a nested scroll only at its directional edge, unless overscroll is contained", () => {
  const nested = document.createElement("div");
  nested.style.overflowY = "auto";
  Object.defineProperties(nested, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 200 },
  });
  const { read } = inputFixture(nested);
  const down = () => new WheelEvent("wheel", { deltaY: 100, bubbles: true });
  expect(read(down())).toBe(0);
  nested.scrollTop = 100;
  expect(read(down())).toBe(1);
  nested.style.overscrollBehaviorY = "contain";
  expect(read(down())).toBe(0);
});

it("uses the canonical native-key contract in both directions", () => {
  const direct = inputFixture();
  expect(direct.read(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }))).toBe(1);
  expect(direct.read(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }))).toBe(-1);
  const native = inputFixture(document.createElement("input"));
  expect(native.read(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))).toBe(0);
});

it("reads one touch threshold in both directions and retires it on reset or end", () => {
  class TestTouchEvent extends Event {
    readonly touches: Array<{ clientY: number }>;
    constructor(type: string, y: number) {
      super(type, { bubbles: true });
      this.touches = [{ clientY: y }];
    }
  }
  vi.stubGlobal("TouchEvent", TestTouchEvent);
  const { read, input } = inputFixture();
  expect(read(new TestTouchEvent("touchstart", 100))).toBe(0);
  expect(read(new TestTouchEvent("touchmove", 94))).toBe(0);
  expect(read(new TestTouchEvent("touchmove", 88))).toBe(1);
  expect(read(new TestTouchEvent("touchmove", 100))).toBe(-1);
  input.reset();
  expect(read(new TestTouchEvent("touchmove", 120))).toBe(0);
  expect(read(new TestTouchEvent("touchstart", 100))).toBe(0);
  expect(read(new TestTouchEvent("touchend", 100))).toBe(0);
  expect(read(new TestTouchEvent("touchmove", 88))).toBe(0);
});
