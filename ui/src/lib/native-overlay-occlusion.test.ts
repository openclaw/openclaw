/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireNativeOverlayOcclusion,
  acquireNativeOverlaySurface,
  subscribeNativeOverlayOcclusion,
} from "./native-overlay-occlusion.ts";

const bridge = vi.hoisted(() => ({ available: true }));
vi.mock("../app/native-browser-host.ts", () => ({
  hasNativeBrowserBridge: () => bridge.available,
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  bridge.available = true;
});

describe("native overlay occlusion", () => {
  it("holds only overlapping native surfaces until the lifecycle releases them", () => {
    const near = vi.fn();
    const far = vi.fn();
    cleanups.push(subscribeNativeOverlayOcclusion(near, () => new DOMRect(0, 0, 100, 100)));
    cleanups.push(subscribeNativeOverlayOcclusion(far, () => new DOMRect(300, 0, 100, 100)));
    const surface = document.createElement("div");
    surface.getBoundingClientRect = () => new DOMRect(20, 20, 50, 50);
    document.body.append(surface);
    const release = acquireNativeOverlaySurface(surface);
    cleanups.push(release, () => surface.remove());
    expect(near.mock.calls).toEqual([[false], [true]]);
    expect(far.mock.calls).toEqual([[false]]);
    release();
    release();
    expect(near.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("stays occluded until every overlay releases and tolerates repeated releases", () => {
    const changes = vi.fn();
    cleanups.push(subscribeNativeOverlayOcclusion(changes, () => null));
    const first = acquireNativeOverlayOcclusion();
    const second = acquireNativeOverlayOcclusion();
    cleanups.push(first, second);
    const lateSubscriber = vi.fn();
    const unsubscribe = subscribeNativeOverlayOcclusion(lateSubscriber, () => null);
    cleanups.push(unsubscribe);

    expect(changes.mock.calls).toEqual([[false], [true]]);
    expect(lateSubscriber).toHaveBeenCalledWith(true);
    first();
    first();
    expect(changes.mock.calls).toEqual([[false], [true]]);
    unsubscribe();
    second();
    expect(changes.mock.calls).toEqual([[false], [true], [false]]);
    expect(lateSubscriber).toHaveBeenCalledTimes(1);
  });

  it("does not acquire or subscribe without the native browser bridge", () => {
    bridge.available = false;
    const changes = vi.fn();
    cleanups.push(subscribeNativeOverlayOcclusion(changes, () => null));
    const release = acquireNativeOverlayOcclusion();
    release();
    release();
    bridge.available = true;
    const nativeRelease = acquireNativeOverlayOcclusion();
    nativeRelease();
    expect(changes.mock.calls).toEqual([[false]]);
  });
});
