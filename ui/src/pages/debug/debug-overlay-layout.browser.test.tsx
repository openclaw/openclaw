import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { DebugOverlayFrame } from "./debug-overlay-frame-view.tsx";

const key = "openclaw.debug-overlay.position";
let dispose: (() => void) | undefined;

async function frameAnimation(panel: HTMLElement) {
  // Runs after the layout's own frame callback, which the preceding render queued.
  await new Promise(requestAnimationFrame);
  const animations = panel.getAnimations();
  expect(animations).toHaveLength(1);
  const [animation] = animations;
  assert(animation?.effect instanceof KeyframeEffect);
  return animation;
}

beforeEach(() => localStorage.removeItem(key));

afterEach(() => {
  dispose?.();
  dispose = undefined;
  localStorage.removeItem(key);
  vi.restoreAllMocks();
});

describe.runIf("__vitest_browser__" in globalThis)("System busyness frame animation", () => {
  it("keeps a running mode animation when a same-mode render leaves its target unchanged", async () => {
    const [state, setState] = createSignal<{ mode: "expanded" | "minimized"; body: JSX.Element }>({
      mode: "minimized",
      body: <div>Diagnostics</div>,
    });
    const mounted = mountSolid(() => (
      <DebugOverlayFrame
        mode={state().mode}
        body={state().body}
        onClose={vi.fn()}
        onToggleMode={vi.fn()}
      />
    ));
    dispose = mounted.unmount;
    const panel = mounted.container.querySelector<HTMLElement>("aside")!;
    const renderFrame = (mode: "expanded" | "minimized", body: JSX.Element) => {
      setState({ mode, body });
      flush();
    };
    flush();
    await vi.dynamicImportSettled();
    await new Promise(requestAnimationFrame);
    const animate = panel.animate.bind(panel);
    vi.spyOn(panel, "animate").mockImplementation((keyframes, options) => {
      const animation = animate(keyframes, options);
      // Own the native clock before a slow frame can finish the animation.
      animation.pause();
      return animation;
    });
    renderFrame("expanded", <div role="status">Loading diagnostics…</div>);
    const animation = await frameAnimation(panel);

    // The expanded frame has a fixed height, so swapping its body keeps the target.
    renderFrame("expanded", <section>Gateway: No active runs.</section>);
    const current = await frameAnimation(panel);
    expect(animation.playState).toBe("paused");
    expect(current).toBe(animation);
    animation.finish();
    await expect(animation.finished).resolves.toBe(animation);
  });
});
