/* @vitest-environment jsdom */
import { For, Show, createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { createKeyedListMotion } from "./keyed-list-motion.ts";

it("retires the last animated content target without another resize or publication", () => {
  const observers: Observer[] = [];
  const animations: Array<{ element: Element; onfinish: (() => void) | null; cancel(): void }> = [];
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: false }));
  // No resize delivery: the owner's retained state must schedule final retirement.
  class Observer {
    readonly targets = new Set<Element>();
    readonly observe = (target: Element) => this.targets.add(target);
    readonly unobserve = vi.fn((target: Element): void => {
      this.targets.delete(target);
    });
    readonly disconnect = vi.fn(() => this.targets.clear());
    constructor() {
      observers.push(this);
    }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
  let unmount = () => {};
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value(this: Element) {
      const animation: (typeof animations)[number] = {
        element: this,
        onfinish: null,
        cancel() {},
      };
      animations.push(animation);
      return animation;
    },
  });
  onTestFinished(() => {
    unmount();
    restorePropertyDescriptor(Element.prototype, "animate", originalAnimate);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const [ids, setIds] = createSignal(["last-process"]);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    return new DOMRect(0, 0, 200, ids().length ? 40 : 0);
  });
  const view = mountSolid(() => {
    const motion = createKeyedListMotion({
      ids,
      scope: () => "processes",
      active: () => true,
      ready: () => true,
    });
    return (
      <Show when={motion.present()}>
        <div ref={motion.shell} data-testid="envelope">
          <div ref={motion.content} data-testid="content">
            <For each={ids()}>
              {(id) => (
                <div ref={motion.row(id)} style={{ transform: "none", opacity: "1" }}>
                  {id}
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    );
  });
  unmount = view.unmount;
  flush();
  vi.advanceTimersToNextFrame();
  flush();
  vi.advanceTimersToNextFrame();
  const envelope = view.getByTestId("envelope");
  const content = view.getByTestId("content");
  expect(observers).toHaveLength(1);
  const observer = observers[0]!;
  expect(observer.targets).toEqual(new Set([content]));

  setIds([]);
  flush();
  vi.advanceTimersToNextFrame();
  flush();
  // Drain the row-removal read before finishing the animation.
  vi.advanceTimersToNextFrame();
  expect(content.isConnected).toBe(true);
  const exit = animations.find((animation) => animation.element === envelope);
  expect(exit).toBeDefined();

  exit!.onfinish?.();
  flush();
  expect(content.isConnected).toBe(false);
  vi.advanceTimersToNextFrame();
  expect(observer.unobserve).toHaveBeenCalledExactlyOnceWith(content);
  expect(observer.disconnect).toHaveBeenCalledOnce();
  expect(observer.targets.size).toBe(0);
});
