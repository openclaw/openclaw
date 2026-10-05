import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../test-helpers/load-styles.ts";
import { renderHoverMarquee } from "./hover-marquee.ts";

let container: HTMLDivElement;
const longTitle = "Review navigation accessibility and keyboard focus — final checklist";

function view(title: string) {
  return html`<a class="session-row-host" href="#session" style="display:block;width:180px">
    ${renderHoverMarquee(title, "sidebar-recent-session__name")}
  </a>`;
}

function show(title: string) {
  render(view(title), container);
  return container.querySelector<HTMLElement>(".hover-marquee")!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
});

describe("hover marquee lifecycle", () => {
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

  it("cancels a pending reveal on disconnection and reconnects the same title", async () => {
    const label = show(longTitle);
    const host = container.querySelector<HTMLElement>("a")!;
    await expect.poll(() => getComputedStyle(label).maskImage).not.toBe("none");
    await userEvent.keyboard("{ArrowRight}");
    host.focus();
    expect(host.matches(":focus-visible")).toBe(true);
    await expect.poll(() => label.style.getPropertyValue("--hover-marquee-shift")).not.toBe("");
    const part = render(view(longTitle), container);
    // Cached Lit views disconnect without discarding their DOM.
    part.setConnected(false);
    const disconnectedLabel = container.querySelector<HTMLElement>(".hover-marquee")!;
    const before = disconnectedLabel.getAttribute("style");
    await new Promise((resolve) => {
      setTimeout(resolve, 650);
    });
    expect(disconnectedLabel.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(disconnectedLabel.getAttribute("style")).toBe(before);
    part.setConnected(true);
    container.querySelector<HTMLElement>("a")!.focus();
    const text = disconnectedLabel.querySelector<HTMLElement>(".hover-marquee__text")!;
    await expect
      .poll(() => new DOMMatrixReadOnly(getComputedStyle(text).transform).m41)
      .toBeLessThan(-1);
  });
});
