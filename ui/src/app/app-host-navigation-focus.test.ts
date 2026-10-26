/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createConnectedShellOwner as createShellOwner } from "./app-host-solid.test-support.ts";
import { resetAppHostTestGlobals } from "./app-host.test-support.ts";
import {
  handleNavDrawerKeydown,
  NAV_DRAWER_TOGGLE_REGISTRATION,
  visibleNavDrawerToggle,
} from "./navigation-surface.ts";
import { registerRouteElement, RouteElements, type RouteElementEvent } from "./route-elements.ts";

afterEach(resetAppHostTestGlobals);

function keydown(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

it.each([
  { open: false, via: "direct" },
  { open: true, via: "direct" },
  { open: true, via: "shortcut" },
])("restores drawer focus only when it was open ($open, $via)", ({ open, via }) => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  const shell = createShellOwner();
  document.body.append(shell.element);
  shell.element.innerHTML =
    '<main class="content" tabindex="-1"><textarea></textarea></main><button></button>';
  const trigger = shell.element.querySelector("button")!;
  Object.defineProperty(trigger, "checkVisibility", { value: () => true });
  const composer = shell.element.querySelector("textarea")!;
  composer.focus();
  Object.assign(shell, { navDrawerOpen: open, navDrawerTrigger: open ? trigger : null });
  onTestFinished(() => shell.element.remove());
  if (via === "shortcut") {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const mac = navigator.platform.startsWith("Mac");
    const event = keydown({ key: "b", code: "KeyB", ctrlKey: !mac, metaKey: mac });
    composer.dispatchEvent(event);
  } else {
    shell.closeNavDrawer({ restoreFocus: true });
  }
  for (const frame of frames) {
    frame(0);
  }
  expect(document.activeElement).toBe(open ? trigger : composer);
});

it("wraps Tab across composed drawer controls using the modal focus order", () => {
  const drawer = Object.assign(document.createElement("nav"), { tabIndex: -1 });
  drawer.innerHTML =
    '<div inert><button id="inert"></button></div><button id="skipped" tabindex="-2"></button><button id="first"></button><div></div>';
  const first = drawer.querySelector<HTMLButtonElement>("#first")!;
  const shadow = drawer.lastElementChild!.attachShadow({ mode: "open" });
  const last = shadow.appendChild(document.createElement("button"));
  for (const button of [...drawer.querySelectorAll("button"), last]) {
    Object.defineProperty(button, "checkVisibility", { value: () => true });
  }
  const host = { navDrawerElement: drawer, closeNavDrawer: vi.fn() };
  drawer.addEventListener("keydown", (event) => handleNavDrawerKeydown(host, event));
  document.body.append(drawer);
  onTestFinished(() => drawer.remove());
  for (const [from, to, shiftKey, root] of [
    [last, first, false, document],
    [first, last, true, shadow],
  ] as const) {
    from.focus();
    const event = keydown({ key: "Tab", shiftKey, composed: true });
    from.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(root.activeElement).toBe(to);
  }
});
it("selects live registered drawer toggles in visible DOM order", () => {
  const root = document.createElement("main");
  const elements = new RouteElements();
  root.addEventListener("openclaw-route-element", (event) =>
    elements.register(event as RouteElementEvent),
  );
  const topbar = root.appendChild(document.createElement("button"));
  const chat = root.appendChild(document.createElement("button"));
  document.body.append(root);
  let topbarVisible = true;
  Object.defineProperty(topbar, "checkVisibility", { value: () => topbarVisible });
  Object.defineProperty(chat, "checkVisibility", { value: () => true });
  const releases = [
    registerRouteElement(chat, NAV_DRAWER_TOGGLE_REGISTRATION),
    registerRouteElement(topbar, NAV_DRAWER_TOGGLE_REGISTRATION),
  ];
  const host = { queryRenderedElements: elements.renderedElements.bind(elements) };
  onTestFinished(() => {
    releases.forEach((release) => release?.());
    root.remove();
  });
  expect(visibleNavDrawerToggle(host)).toBe(topbar);
  topbarVisible = false;
  expect(visibleNavDrawerToggle(host)).toBe(chat);
  chat.remove();
  expect(visibleNavDrawerToggle(host)).toBeUndefined();
});
