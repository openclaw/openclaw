import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createPointerDrag } from "./pointer-drag.ts";

afterEach(() => vi.restoreAllMocks());

function pointer(type: string, pointerId = 7) {
  return new PointerEvent(type, { pointerId, bubbles: true });
}

function fixture() {
  const target = document.createElement("div");
  const captured = new Set<number>();
  target.setPointerCapture = vi.fn((id) => captured.add(id));
  target.hasPointerCapture = (id) => captured.has(id);
  const releasePointerCapture = vi.fn((id: number) => {
    captured.delete(id);
    target.dispatchEvent(pointer("lostpointercapture", id));
  });
  target.releasePointerCapture = releasePointerCapture;
  const { drag, dispose } = createRoot((stop) => ({ drag: createPointerDrag(), dispose: stop }));
  onTestFinished(dispose);
  const handlers = { move: vi.fn(), end: vi.fn(), cancel: vi.fn() };
  return { drag, dispose, target, captured, handlers, releasePointerCapture };
}

it("only admits one pointer and ignores other pointers throughout its lifetime", () => {
  const { drag, target, handlers } = fixture();
  expect(drag.start(pointer("pointerdown"), target, handlers)).toBe(true);
  expect(drag.start(pointer("pointerdown", 8), target, handlers)).toBe(false);
  window.dispatchEvent(pointer("pointermove", 8));
  window.dispatchEvent(pointer("pointerup", 8));
  window.dispatchEvent(pointer("pointercancel", 8));
  target.dispatchEvent(pointer("lostpointercapture", 8));
  expect(handlers.move).not.toHaveBeenCalled();
  expect(handlers.end).not.toHaveBeenCalled();
  expect(handlers.cancel).not.toHaveBeenCalled();
  window.dispatchEvent(pointer("pointermove"));
  expect(handlers.move).toHaveBeenCalledOnce();
  window.dispatchEvent(pointer("pointerup"));
  expect(handlers.end).toHaveBeenCalledOnce();
  expect(handlers.cancel).not.toHaveBeenCalled();
});

it("releases capture before completion and can start another gesture from the completion callback", () => {
  const { drag, target, captured, handlers, releasePointerCapture } = fixture();
  handlers.end.mockImplementation(() => {
    expect(captured.has(7)).toBe(false);
    expect(drag.start(pointer("pointerdown", 8), target, handlers)).toBe(true);
  });
  drag.start(pointer("pointerdown"), target, handlers);
  window.dispatchEvent(pointer("pointerup"));
  expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  expect(handlers.end).toHaveBeenCalledOnce();
  expect(handlers.cancel).not.toHaveBeenCalled();
  expect(captured.has(8)).toBe(true);
});

const cancellations: Array<[string, (state: ReturnType<typeof fixture>) => void, boolean]> = [
  ["pointercancel", () => window.dispatchEvent(pointer("pointercancel")), true],
  ["lostpointercapture", ({ target }) => target.dispatchEvent(pointer("lostpointercapture")), true],
  ["blur", () => window.dispatchEvent(new Event("blur")), true],
  ["explicit", ({ drag }) => drag.cancel(), true],
  ["dispose", ({ dispose }) => dispose(), false],
];

it.each(cancellations)(
  "retires a gesture on %s and ignores later pointer events",
  (_reason, cancel, canRestart) => {
    const state = fixture();
    const { drag, target, captured, handlers } = state;
    drag.start(pointer("pointerdown"), target, handlers);
    cancel(state);
    expect(captured.size).toBe(0);
    expect(handlers.cancel).toHaveBeenCalledOnce();
    window.dispatchEvent(pointer("pointermove"));
    window.dispatchEvent(pointer("pointerup"));
    drag.cancel();
    expect(handlers.move).not.toHaveBeenCalled();
    expect(handlers.end).not.toHaveBeenCalled();
    expect(handlers.cancel).toHaveBeenCalledOnce();
    expect(drag.start(pointer("pointerdown", 8), target, handlers)).toBe(canRestart);
  },
);

it("tracks synthetic input when the browser has no pointer to capture", () => {
  const { drag, target, handlers } = fixture();
  target.setPointerCapture = () => {
    throw new DOMException("No active pointer", "NotFoundError");
  };
  expect(drag.start(pointer("pointerdown"), target, handlers)).toBe(true);
  window.dispatchEvent(pointer("pointerup"));
  expect(handlers.end).toHaveBeenCalledOnce();
});
