import { html, nothing, render, type TemplateResult } from "lit";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDebugOverlayFrame } from "./debug-overlay-frame.ts";

const key = "openclaw.debug-overlay.position";
let container: HTMLDivElement;

function renderFrame(mode: "expanded" | "minimized", body: TemplateResult) {
  render(
    renderDebugOverlayFrame({ mode, body, onClose: vi.fn(), onToggleMode: vi.fn() }),
    container,
  );
  const panel = container.querySelector<HTMLElement>("aside");
  assert(panel);
  return panel;
}

async function mount(mode: "expanded" | "minimized") {
  const panel = renderFrame(mode, html`<div>Diagnostics</div>`);
  await vi.dynamicImportSettled();
  await new Promise(requestAnimationFrame);
  const animate = panel.animate.bind(panel);
  vi.spyOn(panel, "animate").mockImplementation((keyframes, options) => {
    const animation = animate(keyframes, options);
    // Own the native clock before a slow frame can finish the animation.
    animation.pause();
    return animation;
  });
  return panel;
}

async function frameAnimation(panel: HTMLElement) {
  // Runs after the layout's own frame callback, which the preceding render queued.
  await new Promise(requestAnimationFrame);
  const animations = panel.getAnimations();
  expect(animations).toHaveLength(1);
  const [animation] = animations;
  assert(animation?.effect instanceof KeyframeEffect);
  return { animation, end: animation.effect.getKeyframes().at(-1)! };
}

const px = (value: unknown) => Number.parseFloat(String(value));

beforeEach(() => {
  localStorage.removeItem(key);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  localStorage.removeItem(key);
  vi.restoreAllMocks();
});

describe.runIf("__vitest_browser__" in globalThis)("System busyness frame animation", () => {
  it("keeps a running mode animation when a same-mode render leaves its target unchanged", async () => {
    const panel = await mount("minimized");
    renderFrame("expanded", html`<div role="status">Loading diagnostics…</div>`);
    const { animation } = await frameAnimation(panel);

    // The expanded frame has a fixed height, so swapping its body keeps the target.
    renderFrame(
      "expanded",
      html`<section>
        <h3>Gateway</h3>
        <p>No active runs.</p>
      </section>`,
    );
    const { animation: current } = await frameAnimation(panel);
    expect(animation.playState).toBe("paused");
    expect(current).toBe(animation);
    animation.finish();
    await expect(animation.finished).resolves.toBe(animation);
  });

  it("retargets a running animation when a same-mode render moves its settled box", async () => {
    const panel = await mount("expanded");
    renderFrame("minimized", html`<div style="height: 20px">Loading</div>`);
    const { animation, end } = await frameAnimation(panel);

    renderFrame("minimized", html`<div style="height: 50px">Connected</div>`);
    const { animation: retargeted, end: target } = await frameAnimation(panel);
    expect(animation.playState).toBe("idle");
    expect(retargeted).not.toBe(animation);
    expect(px(target.height)).toBeGreaterThan(px(end.height));
    retargeted.finish();
    await expect(retargeted.finished).resolves.toBe(retargeted);
    const settled = panel.getBoundingClientRect();
    expect(px(target.top)).toBeCloseTo(settled.top, 0);
    expect(px(target.height)).toBeCloseTo(settled.height, 0);
  });
});
