import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { HoverMarquee } from "./solid/hover-marquee.tsx";
import "../styles/chat/summary-automations.css";

let container: HTMLDivElement;
let setTitle: (title: string) => void;
let unmount: () => void;
const longTitle = "Review navigation accessibility and keyboard focus — final checklist";

function mount() {
  const [title, updateTitle] = createSignal(longTitle);
  setTitle = updateTitle;
  ({ unmount } = mountSolid(
    () => (
      <a class="session-row-host" href="#session" style="display:block;width:180px">
        <HoverMarquee content={title()} class="sidebar-recent-session__name" options={{}} />
      </a>
    ),
    { container },
  ));
  flush();
}

function show(title: string) {
  setTitle(title);
  flush();
  return container.querySelector<HTMLElement>(".hover-marquee")!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  mount();
});

afterEach(() => {
  unmount();
  container.remove();
  vi.useRealTimers();
});

describe("hover marquee lifecycle", () => {
  it("keeps Automation title fades stable from the first attached layout", async () => {
    unmount();
    let host!: HTMLAnchorElement;
    const [title, updateTitle] = createSignal(longTitle);
    ({ unmount } = mountSolid(
      () => (
        <a ref={(element) => (host = element)} href="#automation" style="display:flex;width:180px">
          <HoverMarquee
            content={title()}
            class="chat-summary__automation-title"
            options={{ host: () => host }}
          />
        </a>
      ),
      { container },
    ));
    flush();
    const label = container.querySelector<HTMLElement>(".chat-summary__automation-title")!;
    const firstMask = getComputedStyle(label).maskImage;
    expect(firstMask).not.toBe("none");
    await expect.poll(() => label.classList.contains("hover-marquee--overflowing")).toBe(true);
    expect(getComputedStyle(label).maskImage).toBe(firstMask);
    updateTitle("Notes");
    flush();
    await expect.poll(() => label.classList.contains("hover-marquee--overflowing")).toBe(false);
    expect(getComputedStyle(label).maskImage).toBe(firstMask);
  });

  it("updates the resting fade when its viewport or title changes", async () => {
    const label = show(longTitle);
    const mask = () => getComputedStyle(label).maskImage;
    await expect.poll(mask).not.toBe("none");
    const host = container.querySelector<HTMLElement>("a")!;
    host.style.width = "1000px";
    await expect.poll(mask).toBe("none");
    host.style.width = "180px";
    await expect.poll(mask).not.toBe("none");
    expect(show("Notes")).toBe(label);
    await expect.poll(mask).toBe("none");
    show(longTitle);
    await expect.poll(mask).not.toBe("none");
  });

  it("cancels a pending reveal on disposal and remounts the same title", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const label = show(longTitle);
    const host = container.querySelector<HTMLElement>("a")!;
    await expect.poll(() => getComputedStyle(label).maskImage).not.toBe("none");
    await userEvent.keyboard("{ArrowRight}");
    host.focus();
    expect(host.matches(":focus-visible")).toBe(true);
    await expect.poll(() => label.style.getPropertyValue("--hover-marquee-shift")).not.toBe("");
    unmount();
    const before = label.getAttribute("style");
    await vi.advanceTimersByTimeAsync(650);
    expect(label.isConnected).toBe(false);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(label.getAttribute("style")).toBe(before);
    mount();
    const remountedLabel = show(longTitle);
    container.querySelector<HTMLElement>("a")!.focus();
    // Native visibility and layout callbacks arm the reveal timer after reconnecting.
    await expect
      .poll(async () => {
        await vi.advanceTimersByTimeAsync(500);
        return remountedLabel.classList.contains("hover-marquee--scrolling");
      })
      .toBe(true);
    const text = remountedLabel.querySelector<HTMLElement>(".hover-marquee__text")!;
    await expect
      .poll(() => new DOMMatrixReadOnly(getComputedStyle(text).transform).m41)
      .toBeLessThan(-1);
  });
});
