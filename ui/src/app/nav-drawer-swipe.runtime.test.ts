import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavDrawerSwipeOwner } from "./nav-drawer-swipe.runtime.ts";

type TestHost = HTMLElement & {
  onboardingMode: boolean;
  updateComplete: Promise<boolean>;
  navDrawerOpen: boolean;
};

function createHost(): TestHost {
  const host = document.createElement("div") as TestHost;
  host.onboardingMode = false;
  host.navDrawerOpen = false;
  host.updateComplete = Promise.resolve(true);
  host.innerHTML = `
    <div class="shell-nav"></div>
    <div class="shell-nav-backdrop"></div>
    <div class="content">
      <div class="plain-region"></div>
      <div class="terminal-region">
        <canvas></canvas>
        <textarea></textarea>
      </div>
    </div>
  `;
  document.body.appendChild(host);
  return host;
}

/**
 * jsdom ships no TouchEvent constructor, so the touch list is attached to a
 * plain Event. Dispatching it through the real tree keeps composedPath()
 * authentic, which is the part of handleStart under test.
 */
function dispatchTouch(
  target: Element,
  type: "touchstart" | "touchmove" | "touchend",
  clientX: number,
): void {
  const event = new Event(type, { bubbles: true, composed: true, cancelable: true });
  const touches = [{ identifier: 0, clientX, clientY: 100 }];
  Object.defineProperties(event, {
    touches: { value: type === "touchend" ? [] : touches },
    changedTouches: { value: touches },
  });
  target.dispatchEvent(event);
}

/** Drags left-to-right far enough to clear both the lock and open thresholds. */
function swipeRight(target: Element): void {
  dispatchTouch(target, "touchstart", 10);
  dispatchTouch(target, "touchmove", 80);
  dispatchTouch(target, "touchend", 80);
}

describe("NavDrawerSwipeOwner", () => {
  let host: TestHost;
  let requestOpen: ReturnType<typeof vi.fn>;
  let owner: NavDrawerSwipeOwner;

  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList),
    );
    host = createHost();
    requestOpen = vi.fn();
    owner = new NavDrawerSwipeOwner(host, requestOpen);
    owner.connect();
  });

  afterEach(() => {
    owner.disconnect();
    host.remove();
    vi.unstubAllGlobals();
  });

  it("opens the drawer for a horizontal drag over ordinary content", () => {
    const plain = host.querySelector(".plain-region");
    expect(plain).not.toBeNull();

    swipeRight(plain as Element);

    expect(requestOpen).toHaveBeenCalledTimes(1);
  });

  it("leaves a horizontal drag over a canvas to the canvas", () => {
    // A terminal or VNC surface paints its own selection onto a canvas and has
    // no ancestor matching the other opt-out entries: the textarea it keeps for
    // IME is a sibling. Without canvas in the selector the drawer claims every
    // drag-select in the terminal.
    const canvas = host.querySelector("canvas");
    expect(canvas).not.toBeNull();

    swipeRight(canvas as Element);

    expect(requestOpen).not.toHaveBeenCalled();
  });
});
