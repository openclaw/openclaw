import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../../styles.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-progress.css";
import { createComposerProps } from "./chat-composer.test-support.ts";
import { renderChatComposer, resetChatComposerState } from "./components/chat-composer.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

let container: HTMLDivElement;
let releaseDismissal: () => void;
let viewport: { width: number; height: number };

beforeEach(() => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  container = document.createElement("div");
  document.body.append(container);
  releaseDismissal = installChatComposerPickerDismissal(document);
});

afterEach(async () => {
  render(nothing, container);
  container.remove();
  resetChatComposerState();
  releaseDismissal();
  vi.unstubAllGlobals();
  await page.viewport(viewport.width, viewport.height);
});

function drawComposer(attachment = false, goal = false) {
  render(
    renderChatComposer(
      createComposerProps({
        goalDraftMode: goal ? { action: "start" } : null,
        attachments: attachment
          ? [{ id: "context-proof", mimeType: "text/plain", fileName: "proof.txt" }]
          : [],
        selectedSession: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          totalTokens: 20_300,
          contextTokens: 200_000,
          inputTokens: 19_600,
          outputTokens: 126,
        },
      }),
    ),
    container,
  );
  return {
    composer: container.querySelector<HTMLElement>(".agent-chat__input")!,
    trigger: container.querySelector<HTMLElement>(".context-ring")!,
    popover: container.querySelector<HTMLElement>(".context-usage__popover")!,
  };
}

function isPainted(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    [rect.left + 1, rect.right - 1].every((x) =>
      element.contains(document.elementFromPoint(x, rect.top + rect.height / 2)),
    )
  );
}

describe("context usage popup geometry", () => {
  it("paints the complete readout outside a clipped short split pane and dismisses it", async () => {
    await page.viewport(1280, 720);
    // Reproduce the bounded right conversation above Files; the renderer and
    // its popup retain their production styles and event handlers.
    container.style.cssText =
      "position:fixed;left:772px;top:48px;width:508px;height:312px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end";
    const { trigger, popover } = drawComposer(false, true);
    await page.elementLocator(trigger).click();
    const readout = [
      ...popover.querySelectorAll<HTMLElement>(".context-usage__title, strong, dt, dd"),
    ];
    expect(readout.map((element) => element.textContent?.trim())).toEqual([
      "Context window",
      "20.3k / 200k · 10%",
      "Input",
      "19.6k",
      "Output",
      "126",
    ]);
    await expect.poll(() => readout.every(isPainted)).toBe(true);
    const box = popover.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(1280);
    expect(box.top).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => popover.checkVisibility()).toBe(false);
    expect(document.activeElement).toBe(trigger);
    await page.elementLocator(trigger).click();
    await expect.poll(() => readout.every(isPainted)).toBe(true);
    await page
      .elementLocator(container)
      .click({ position: { x: container.clientWidth - 2, y: 2 } });
    await expect.poll(() => popover.checkVisibility()).toBe(false);
  });

  it.each([
    [320, 568, false],
    [375, 812, false],
    [667, 375, false],
    [768, 500, false],
    [320, 568, true],
    [667, 375, true],
  ] as const)(
    "keeps context usage above the mobile composer at %sx%s (attachment: %s)",
    async (width, height, attachment) => {
      await page.viewport(width, height);
      container.style.cssText = "position:fixed;bottom:16px;left:16px;right:16px";
      const { composer, trigger, popover } = drawComposer(attachment);
      await page.elementLocator(trigger).click();
      await expect
        .poll(() => {
          const box = popover.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.left >= 0 &&
            box.right <= width + 1 &&
            box.top >= 0 &&
            box.bottom <= composer.getBoundingClientRect().top + 1
          );
        })
        .toBe(true);
      expect(trigger.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    },
  );

  it("keeps context usage in a panned visual viewport", async () => {
    await page.viewport(375, 812);
    const actualViewport = window.visualViewport!;
    vi.stubGlobal("visualViewport", {
      width: 375,
      height: 400,
      offsetTop: 300,
      offsetLeft: 0,
      scale: 1,
      addEventListener: actualViewport.addEventListener.bind(actualViewport),
      removeEventListener: actualViewport.removeEventListener.bind(actualViewport),
    });
    container.style.cssText = "position:fixed;top:600px;left:16px;right:16px";
    const { composer, trigger, popover } = drawComposer();
    await page.elementLocator(trigger).click();
    await expect
      .poll(() => {
        const box = popover.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.top >= 300 &&
          Math.abs(box.bottom - (composer.getBoundingClientRect().top - 6)) <= 1
        );
      })
      .toBe(true);
  });
});
