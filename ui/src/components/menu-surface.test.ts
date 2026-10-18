/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeNativeOverlayOcclusion } from "../lib/native-overlay-occlusion.ts";
import { promoteToPopoverTopLayer } from "./menu-surface.ts";

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

describe("openclaw-menu-surface", () => {
  it("promotes itself to the top layer on every connect", () => {
    const surface = document.createElement("openclaw-menu-surface");
    const showPopover = vi.fn();
    surface.showPopover = showPopover;
    document.body.append(surface);
    expect(surface.getAttribute("popover")).toBe("manual");
    expect(showPopover).toHaveBeenCalledTimes(1);

    // Menus toggle by removing/re-adding the surface; each reopen must
    // re-enter the top layer.
    surface.remove();
    document.body.append(surface);
    expect(showPopover).toHaveBeenCalledTimes(2);
  });
});

describe("native overlay occlusion for menus", () => {
  it("keeps overlapping surfaces occluded until their close or removal, including shadow roots", async () => {
    bridge.available = true;
    const changes = vi.fn();
    unsubscribe = subscribeNativeOverlayOcclusion(changes, () => new DOMRect(0, 0, 500, 500));
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.getBoundingClientRect = () => new DOMRect(10, 10, 100, 100);
    second.getBoundingClientRect = () => new DOMRect(20, 20, 100, 100);
    root.append(first, second);
    first.showPopover = vi.fn();
    promoteToPopoverTopLayer(first);
    promoteToPopoverTopLayer(first);
    // Native webviews also cover top-layer menus.
    promoteToPopoverTopLayer(second);
    await new Promise(requestAnimationFrame);
    expect(changes.mock.calls).toEqual([[false], [true]]);

    const closed = new Event("toggle");
    Object.defineProperty(closed, "newState", { value: "closed" });
    first.dispatchEvent(closed);
    expect(changes.mock.calls).toEqual([[false], [true]]);
    second.remove();
    await Promise.resolve();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);

    promoteToPopoverTopLayer(first);
    await new Promise(requestAnimationFrame);
    host.remove();
    await Promise.resolve();
    expect(changes.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
  });
});
