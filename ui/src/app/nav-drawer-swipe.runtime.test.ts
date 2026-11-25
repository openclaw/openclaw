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

it.each([
  { modal: "none", startX: 24 },
  { modal: "before", startX: 24 },
  { modal: "during", startX: 24 },
  { modal: "connecting", startX: 24 },
  { modal: "none", startX: 32 },
  { modal: "none", startX: 33 },
  { modal: "none", startX: 160 },
])(
  "opens only from the left edge when navigation is available ($modal, x=$startX)",
  ({ modal, startX }) => {
    document.openClawModalLayers = new Set();
    const element = document.createElement("div");
    host = element;
    element.innerHTML =
      '<div class="content"><video></video></div><nav class="shell-nav"></nav><div class="shell-nav-backdrop"></div>';
    document.body.append(element);
    const open = vi.fn();
    owner = new NavDrawerSwipeOwner(
      {
        element,
        navDrawerElement: element.querySelector<HTMLElement>(".shell-nav") ?? undefined,
        get isConnected() {
          return element.isConnected;
        },
        onboardingMode: false,
        initialConnectionPending: modal === "connecting",
        navDrawerOpen: false,
      },
      open,
    );
    owner.connect();
    const touch = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
      const points = [{ identifier: 1, clientX: x, clientY: 100 }];
      Object.defineProperties(event, {
        touches: { value: type === "touchend" ? [] : points },
        changedTouches: { value: points },
      });
      element.querySelector("video")!.dispatchEvent(event);
      return event;
    };
    if (modal === "before") {
      document.openClawModalLayers.add(document.createElement("div"));
    }
    touch("touchstart", startX);
    if (modal === "during") {
      document.openClawModalLayers.add(document.createElement("div"));
    }
    const move = touch("touchmove", startX + 100);
    touch("touchend", startX + 100);
    const shouldOpen = modal === "none" && startX <= 32;
    expect(move.defaultPrevented).toBe(shouldOpen);
    expect(open).toHaveBeenCalledTimes(shouldOpen ? 1 : 0);
  },
);

it("preserves menu focus when gesture support connects to an open drawer", () => {
  const element = document.createElement("div");
  host = element;
  const drawer = element.appendChild(document.createElement("nav"));
  drawer.className = "shell-nav";
  const first = drawer.appendChild(document.createElement("button"));
  const selected = drawer.appendChild(document.createElement("button"));
  for (const button of [first, selected]) {
    Object.defineProperty(button, "checkVisibility", { value: () => true });
  }
  document.body.append(element);
  selected.focus();
  owner = new NavDrawerSwipeOwner(
    {
      element,
      navDrawerElement: drawer,
      get isConnected() {
        return element.isConnected;
      },
      onboardingMode: false,
      navDrawerOpen: true,
    },
    vi.fn(),
  );

  owner.connect();

  expect(document.activeElement).toBe(selected);
});
