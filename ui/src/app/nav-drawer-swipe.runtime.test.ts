/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { NavDrawerSwipeOwner } from "./nav-drawer-swipe.runtime.ts";
vi.mock("./mobile-nav-layout.ts", () => ({ isMobileNavLayout: () => true }));
const previousLayers = document.openClawModalLayers;
let owner: NavDrawerSwipeOwner | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  owner?.disconnect();
  host?.remove();
  document.openClawModalLayers = previousLayers;
});

it.each(["none", "before", "during"])("opens the drawer only without a modal (%s)", (modal) => {
  document.openClawModalLayers = new Set();
  const element = Object.assign(document.createElement("div"), {
    onboardingMode: false,
    navDrawerOpen: false,
    updateComplete: Promise.resolve(true),
  });
  host = element;
  element.innerHTML =
    '<div class="content"><video></video></div><nav class="shell-nav"></nav><div class="shell-nav-backdrop"></div>';
  document.body.append(element);
  const open = vi.fn();
  owner = new NavDrawerSwipeOwner(element, open);
  owner.connect();
  const touch = (type: string, x: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
    const points = [{ identifier: 1, clientX: x, clientY: 100 }];
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : points },
      changedTouches: { value: points },
    });
    element.querySelector("video")!.dispatchEvent(event);
  };
  if (modal === "before") {
    document.openClawModalLayers.add(document.createElement("div"));
  }
  touch("touchstart", 100);
  if (modal === "during") {
    document.openClawModalLayers.add(document.createElement("div"));
  }
  touch("touchmove", 200);
  touch("touchend", 200);
  expect(open).toHaveBeenCalledTimes(modal === "none" ? 1 : 0);
});
