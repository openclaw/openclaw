/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { observeMenuSpacing } from "./menu-spacing.ts";
import { hasMenuSurface, promoteToPopoverTopLayer } from "./menu-surface.ts";

const bridge = vi.hoisted(() => ({ available: false }));
vi.mock("../app/native-browser-host.ts", () => ({
  hasNativeBrowserBridge: () => bridge.available,
}));
let unsubscribe: (() => void) | undefined;
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  unsubscribe?.();
  unsubscribe = undefined;
  bridge.available = false;
});
const frame = () => new Promise(requestAnimationFrame);

it("ignores decorative changes while keeping menu row boundaries current", async () => {
  const root = document.createElement("div");
  root.innerHTML = '<button class="oc-menu-item"><span></span></button>';
  const row = root.firstElementChild!;
  const avatar = row.firstElementChild!;
  const disconnect = observeMenuSpacing(root);
  const scan = vi.spyOn(row.classList, "contains");
  try {
    avatar.className = "is-fallback";
    avatar.append(document.createElement("img"));
    await frame();
    expect(scan).not.toHaveBeenCalled();
    expect(root.hasAttribute("data-menu-row-end")).toBe(true);
    row.className = "";
    await frame();
    expect(root.hasAttribute("data-menu-row-end")).toBe(false);
    row.className = "oc-menu-item";
    await frame();
    expect(root.hasAttribute("data-menu-row-end")).toBe(true);
    row.remove();
    await frame();
    expect(root.hasAttribute("data-menu-row-end")).toBe(false);
  } finally {
    disconnect();
    scan.mockRestore();
  }
});

function positioned<K extends keyof HTMLElementTagNameMap>(tag: K, x: number, size = 50, y = 20) {
  const element = document.createElement(tag);
  element.getBoundingClientRect = () => new DOMRect(x, y, size, size);
  return element;
}
function observe(size: number) {
  bridge.available = true;
  const changes = vi.fn();
  unsubscribe = subscribeNativeOverlayOcclusion(changes, () => new DOMRect(0, 0, size, size));
  return (...values: boolean[]) =>
    expect(changes.mock.calls).toEqual(values.map((value) => [value]));
}

it("promotes itself on every connect and tracks document adoption", () => {
  const surface = document.createElement("openclaw-menu-surface");
  const showPopover = vi.fn();
  surface.showPopover = showPopover;
  const otherDocument = document.implementation.createHTMLDocument();
  for (const [move, calls, here, there] of [
    [() => document.body.append(surface), 1, true, false],
    [() => surface.remove(), 1, false, false],
    [() => document.body.append(surface), 2, true, false],
    [() => otherDocument.body.append(surface), 3, false, true],
    [() => surface.remove(), 3, false, false],
  ] as const) {
    move();
    expect(showPopover).toHaveBeenCalledTimes(calls);
    expect([hasMenuSurface(document), hasMenuSurface(otherDocument)]).toEqual([here, there]);
  }
  expect(surface.getAttribute("popover")).toBe("manual");
  expect(surface.matches(":popover-open")).toBe(false);
});

it("follows live positioned children of a zero-sized menu host", async () => {
  const check = observe(100);
  const surface = positioned("openclaw-menu-surface", 0, 0, 0);
  surface.showPopover = vi.fn();
  surface.append(positioned("section", 20));
  document.body.append(surface);
  await frame();
  check(false, true);
  const replacement = positioned("section", 200);
  surface.replaceChildren(replacement);
  await frame();
  check(false, true, false);
  replacement.getBoundingClientRect = () => new DOMRect(20, 20, 50, 50);
  await frame();
  check(false, true, false, true);
});

it("occludes overlapping shadow-root surfaces until close or removal", async () => {
  const check = observe(500);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const first = positioned("div", 10, 100, 10);
  const second = positioned("div", 20, 100);
  root.append(first, second);
  first.showPopover = vi.fn();
  const promote = (element: HTMLElement) => promoteToPopoverTopLayer(element, () => [element]);
  promote(first);
  promote(first);
  promote(second);
  await frame();
  check(false, true);
  first.dispatchEvent(Object.assign(new Event("toggle"), { newState: "closed" }));
  check(false, true);
  second.remove();
  await Promise.resolve();
  check(false, true, false);
  promote(first);
  await frame();
  host.remove();
  await Promise.resolve();
  check(false, true, false, true, false);
});
