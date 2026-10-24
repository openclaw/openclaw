import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  createComposerContainer,
  createComposerProps,
  disposeComposer,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
import "../../styles.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-progress.css";

import { resetChatComposerState } from "./components/chat-composer.tsx";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

let container: HTMLDivElement;
let releaseDismissal: () => void;
let viewport: { width: number; height: number };

beforeEach(() => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  container = createComposerContainer();
  document.body.append(container);
  releaseDismissal = installChatComposerPickerDismissal(document);
});

afterEach(async () => {
  disposeComposer(container);
  container.remove();
  resetChatComposerState();
  releaseDismissal();
  vi.unstubAllGlobals();
  await page.viewport(viewport.width, viewport.height);
});

function drawComposer(attachment = false, goal = false) {
  renderComposerInto(
    container,
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
  );
  return {
    composer: container.querySelector<HTMLElement>(".agent-chat__input")!,
    trigger: container.querySelector<HTMLElement>(".context-ring")!,
    popover: container.querySelector<HTMLElement>(".context-usage [data-anchored-overlay]")!,
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

async function expectBounds(element: HTMLElement, matches: (box: DOMRect) => boolean) {
  await expect.poll(() => matches(element.getBoundingClientRect())).toBe(true);
}

it("paints the complete readout outside a clipped short split pane and dismisses it", async () => {
  await page.viewport(1280, 720);
  container.style.cssText =
    "position:fixed;left:772px;top:48px;width:508px;height:312px;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end";
  const { trigger, popover } = drawComposer(false, true);
  await page.elementLocator(trigger).click();
  const readout = () => [
    ...popover.querySelectorAll<HTMLElement>(".context-usage__title, strong, dt, dd"),
  ];
  expect(readout().map((element) => element.textContent?.trim())).toEqual([
    "Context window",
    "20.3k / 200k · 10%",
    "Input",
    "19.6k",
    "Output",
    "126",
  ]);
  const readoutPainted = () => readout().length === 6 && readout().every(isPainted);
  await expect.poll(readoutPainted).toBe(true);
  const box = popover.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(1280);
  expect(box.top).toBeGreaterThanOrEqual(0);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => popover.checkVisibility()).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await page.elementLocator(trigger).click();
  await expect.poll(readoutPainted).toBe(true);
  await page.elementLocator(container).click({ position: { x: container.clientWidth - 2, y: 2 } });
  await expect.poll(() => popover.checkVisibility()).toBe(false);
});

it.each([
  [667, 375, false, false],
  [320, 568, true, false],
  [375, 812, false, true],
] as const)(
  "fits context at %sx%s (attachment: %s, panned: %s)",
  async (width, height, attachment, panned) => {
    await page.viewport(width, height);
    if (panned) {
      const actual = window.visualViewport!;
      vi.stubGlobal("visualViewport", {
        width: 375,
        height: 400,
        offsetTop: 300,
        offsetLeft: 0,
        scale: 1,
        addEventListener: actual.addEventListener.bind(actual),
        removeEventListener: actual.removeEventListener.bind(actual),
      });
    }
    container.style.cssText = panned
      ? "position:fixed;top:600px;left:16px;right:16px"
      : "position:fixed;bottom:16px;left:16px;right:16px";
    const { composer, trigger, popover } = drawComposer(attachment);
    await page.elementLocator(trigger).click();
    await expectBounds(
      popover,
      (box) =>
        box.width > 0 &&
        box.top >= (panned ? 300 : 0) &&
        (panned
          ? Math.abs(box.bottom - (composer.getBoundingClientRect().top - 6)) <= 1
          : box.left >= 0 &&
            box.right <= width + 1 &&
            box.bottom <= composer.getBoundingClientRect().top + 1),
    );
    if (!panned) {
      expect(trigger.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    }
  },
);
