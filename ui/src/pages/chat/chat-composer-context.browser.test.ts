import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { registerChatDetailsEnglish } from "../../i18n/locales/en-chat-details.ts";
import "../../styles.css";
import "../../styles/chat.ts";
import "../../styles/chat/composer.css";
import "../../styles/chat/composer-progress.css";

import { registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import {
  createComposerContainer,
  createComposerProps,
  disposeComposer,
  renderComposerInto,
} from "./chat-composer.test-support.ts";
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

function labelBox(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(
    [...element.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent)!,
  );
  return range.getBoundingClientRect();
}

const center = (box: DOMRect) => box.top + box.height / 2;

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
    "In",
    "19.6k",
    "Out",
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
          ? Math.abs(box.bottom - (composer.getBoundingClientRect().top - 4)) <= 1
          : box.left >= 0 &&
            box.right <= width + 1 &&
            box.bottom <= composer.getBoundingClientRect().top + 1),
    );
    if (!panned) {
      expect(trigger.getBoundingClientRect().bottom).toBeLessThanOrEqual(height + 1);
    }
  },
);

it.each([1280, 320] as const)(
  "centers a secondary Compact on the View context row at %spx and stays open while it runs",
  async (width) => {
    // The breakdown module registers the View context label; measure the real copy, not its key.
    registerEnglishCatalog(registerChatDetailsEnglish);
    await page.viewport(width, 720);
    container.style.cssText = "position:fixed;bottom:16px;left:16px;right:16px";
    const pending = Promise.withResolvers<void>();
    const onCompact = vi.fn(() => pending.promise);
    renderComposerInto(
      container,
      createComposerProps({
        onCompact,
        selectedSession: {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          totalTokens: 190_000,
          contextTokens: 200_000,
        },
      }),
    );
    const trigger = container.querySelector<HTMLElement>(".context-ring")!;
    const popover = container.querySelector<HTMLElement>(".context-usage [data-anchored-overlay]")!;
    await page.elementLocator(trigger).click();
    const open = popover.querySelector<HTMLElement>(".context-usage__open")!;
    const compact = popover.querySelector<HTMLButtonElement>(".chat-context__compact")!;
    await expect.poll(() => isPainted(open) && isPainted(compact)).toBe(true);
    const link = open.getBoundingClientRect();
    const action = compact.getBoundingClientRect();
    const linkText = labelBox(open);
    const actionText = labelBox(compact);
    expect(open.textContent).toBe("View context");
    // One baseline for both labels, and the outline centered on that shared line
    // (WebKit rounds text boxes to whole pixels).
    expect(Math.abs(linkText.bottom - actionText.bottom)).toBeLessThan(0.5);
    expect(Math.abs(center(action) - center(actionText))).toBeLessThanOrEqual(1);
    expect(open.parentElement!.getBoundingClientRect().height).toBe(26);
    expect(link.right).toBeLessThan(action.left);
    expect(action.right).toBeLessThanOrEqual(popover.getBoundingClientRect().right);
    // 95% fresh usage still renders the outlined secondary treatment.
    expect(getComputedStyle(compact).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    await page.elementLocator(compact).click();
    await expect.poll(() => compact.textContent).toBe("Compacting");
    expect(compact.disabled).toBe(true);
    expect(popover.checkVisibility()).toBe(true);
    pending.resolve();
    await expect.poll(() => compact.textContent).toBe("Compact");
    expect(popover.checkVisibility()).toBe(true);
    expect(onCompact).toHaveBeenCalledOnce();
  },
);
