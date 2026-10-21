import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatDetailsDesktopSection } from "./chat-details-desktop-section.tsx";

let dispose: (() => void) | undefined;
let container: HTMLDivElement;
afterEach(() => {
  dispose?.();
  container?.remove();
});

function mount(initiallyExpanded: boolean) {
  container = document.body.appendChild(document.createElement("div"));
  function Section(props: { height: number; presented: boolean }) {
    const [expanded, setExpanded] = createSignal(initiallyExpanded);
    return (
      <ChatDetailsDesktopSection
        section="outputs"
        title="Outputs"
        expanded={expanded()}
        presented={props.presented}
        onExpandedChange={setExpanded}
      >
        <div style={{ height: `${props.height}px` }}>
          <button type="button">Open artifact</button>
        </div>
      </ChatDetailsDesktopSection>
    );
  }
  const view = mountSolid(Section, { height: 80, presented: true }, container);
  dispose = view.dispose;
  const disclosure = container.querySelector("details")!;
  const summary = container.querySelector("summary")!;
  const artifact = container.querySelector("button")!;
  return { view, disclosure, summary, artifact };
}

async function settleAnimations(element: HTMLElement) {
  for (;;) {
    flush();
    // Let layout deliver the resize that can replace the current animation.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    const animations = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState !== "finished" && animation.playState !== "idle");
    if (animations.length === 0) {
      return;
    }
    await Promise.all(
      animations.map(async (animation) => {
        try {
          await animation.finished;
        } catch (error) {
          // Retargeting cancels this promise; the next pass awaits its replacement.
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            throw error;
          }
        }
      }),
    );
  }
}

it("restores a closed choice before paint and gives keyboard activation immediate access", async () => {
  const { disclosure, summary, artifact } = mount(false);
  expect(disclosure.open).toBe(false);
  expect(artifact.checkVisibility()).toBe(false);
  summary.focus();
  await userEvent.keyboard("{Enter}");
  flush();
  expect(disclosure.open).toBe(true);
  expect(artifact.checkVisibility()).toBe(true);
  expect(disclosure.getAnimations({ subtree: true })).toHaveLength(0);
  await userEvent.tab();
  expect(document.activeElement).toBe(artifact);
  summary.focus();
  await userEvent.keyboard("{Enter}");
  flush();
  expect(disclosure.open).toBe(false);
  expect(document.activeElement).toBe(summary);
});

it("reverses a pointer collapse, accommodates new content, and settles when parked", async () => {
  const { view, disclosure, summary, artifact } = mount(true);
  await userEvent.click(summary);
  flush();
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(artifact.closest("[inert]")).not.toBeNull();
  await userEvent.click(summary);
  flush();
  view.update({ height: 160, presented: true });
  await settleAnimations(disclosure);
  expect(disclosure.open).toBe(true);
  expect(artifact.closest("[inert]")).toBeNull();
  // The body is not stuck at the old height when its real content grows.
  expect(disclosure.getBoundingClientRect().height).toBeGreaterThan(160);
  await userEvent.click(summary);
  flush();
  view.update({ height: 160, presented: false });
  expect(disclosure.open).toBe(false);
  expect(disclosure.getAnimations({ subtree: true })).toHaveLength(0);
});

it("opens from the collapsed height and reverses from the visible height", async () => {
  const { disclosure, summary } = mount(false);
  const body = disclosure.querySelector<HTMLElement>(".chat-details-desktop-section__body")!;
  const animate = body.animate.bind(body);
  // Pause at creation before a resize callback can retarget advancing geometry.
  const animationSpy = vi.spyOn(body, "animate").mockImplementation((frames, options) => {
    const animation = animate(frames, options);
    animation.pause();
    return animation;
  });
  onTestFinished(() => {
    animationSpy.mockRestore();
  });
  await userEvent.click(summary);
  flush();
  const opening = body.getAnimations()[0]!;
  opening.currentTime = 0;
  expect(body.getBoundingClientRect().height).toBe(0);
  opening.currentTime = Number(opening.effect!.getTiming().duration) / 2;
  const visibleHeight = body.getBoundingClientRect().height;
  expect(visibleHeight).toBeGreaterThan(0);
  expect(visibleHeight).toBeLessThan(80);

  await userEvent.click(summary);
  flush();
  const closing = body.getAnimations()[0]!;
  closing.currentTime = 0;
  expect(body.getBoundingClientRect().height).toBeCloseTo(visibleHeight, 0);
  const finished = new Promise<void>((resolve) => {
    closing.addEventListener("finish", () => resolve(), { once: true });
  });
  closing.finish();
  await finished;
  expect(disclosure.open).toBe(false);
  expect(body.style.height).toBe("");
});
