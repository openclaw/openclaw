import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/composer.css";
import { renderCommentPreviewChip, renderCommentPreviewRow } from "./chat-comment-preview.ts";
import { removeChatSelectionPopup, showChatAnnotationEditor } from "./chat-selection-popup.ts";

const longSelection = "Selected passage with enough words to exceed a compact preview. ".repeat(8);
const longComment =
  "Please verify the deployment checklist and retain the original context. ".repeat(24);
let container: HTMLDivElement;
let originalTheme: string | undefined;

beforeEach(async () => {
  originalTheme = document.documentElement.dataset.themeMode;
  await page.viewport(1440, 900);
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  removeChatSelectionPopup();
  render(nothing, container);
  container.remove();
  if (originalTheme === undefined) {
    delete document.documentElement.dataset.themeMode;
  } else {
    document.documentElement.dataset.themeMode = originalTheme;
  }
});

function mountComments(count: number, top: number) {
  container.style.cssText = `position: fixed; right: 16px; top: ${top}px`;
  render(
    renderCommentPreviewChip(
      count,
      html`<ol class="chat-comment-preview__list">
        ${Array.from({ length: count }, () =>
          renderCommentPreviewRow({ text: longSelection, comment: longComment }),
        )}
      </ol>`,
    ),
    container,
  );
  return container.querySelector<HTMLElement>(".chat-selection-annotations__chip")!;
}

async function openComments(trigger: HTMLElement) {
  const tooltip = container.querySelector("openclaw-tooltip")!;
  await tooltip.updateComplete;
  const popup = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
  const shown = new Promise<Event>((resolve) => {
    popup.addEventListener("wa-after-show", resolve, { once: true });
  });
  trigger.focus();
  await shown;
  await expect.poll(() => popup.open).toBe(true);
  const body = popup.shadowRoot!.querySelector<HTMLElement>('[part="body"]')!;
  await expect.poll(() => body.getBoundingClientRect().height).toBeGreaterThan(0);
  return { tooltip, body };
}

function contrast(element: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const ancestors: HTMLElement[] = [];
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    ancestors.unshift(current);
  }
  context.fillStyle = "white";
  context.fillRect(0, 0, 1, 1);
  for (const ancestor of ancestors) {
    context.fillStyle = getComputedStyle(ancestor).backgroundColor;
    context.fillRect(0, 0, 1, 1);
  }
  const luminance = (pixels: Uint8ClampedArray) => {
    const linear = Array.from(pixels.slice(0, 3), (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const background = luminance(context.getImageData(0, 0, 1, 1).data);
  context.fillStyle = getComputedStyle(element).color;
  context.fillRect(0, 0, 1, 1);
  const foreground = luminance(context.getImageData(0, 0, 1, 1).data);
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
}

describe("annotation chip and hovercard", () => {
  it.each(["light", "dark"])("keeps attachment-chip text readable in %s", async (theme) => {
    document.documentElement.dataset.themeMode = theme;
    const trigger = mountComments(3, 450);
    await container.querySelector("openclaw-tooltip")!.updateComplete;
    await expect.poll(() => trigger.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(trigger.classList.contains("chat-attachment-thumb")).toBe(true);
    expect(trigger.classList.contains("chat-attachment-thumb--file")).toBe(true);
    const text = trigger.querySelector<HTMLElement>(".chat-attachment-file")!;
    expect(text).not.toBeNull();
    expect(contrast(text)).toBeGreaterThanOrEqual(4.5);
    await page.elementLocator(trigger).hover();
    await expect.poll(() => contrast(text)).toBeGreaterThanOrEqual(4.5);
    await page.elementLocator(document.body).hover({ position: { x: 2, y: 2 } });
    await userEvent.keyboard("{ArrowRight}");
    trigger.focus();
    expect(trigger.matches(":focus-visible")).toBe(true);
    const focusStyle = getComputedStyle(trigger);
    expect(
      (focusStyle.outlineStyle !== "none" && Number.parseFloat(focusStyle.outlineWidth) > 0) ||
        focusStyle.boxShadow !== "none",
    ).toBe(true);
    await expect.poll(() => contrast(text)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([1440, 390])(
    "bounds 1, 3 and 10 long comments at viewport edges (%ipx)",
    async (width) => {
      await page.viewport(width, 900);
      for (const count of [1, 3, 10]) {
        for (const top of [12, 430, 840]) {
          const trigger = mountComments(count, top);
          const { tooltip, body } = await openComments(trigger);
          await expect
            .poll(() => {
              const card = body.getBoundingClientRect();
              const anchor = trigger.getBoundingClientRect();
              return (
                card.left >= 0 &&
                card.right <= window.innerWidth &&
                card.top >= 0 &&
                card.bottom <= window.innerHeight &&
                (card.bottom <= anchor.top || card.top >= anchor.bottom)
              );
            })
            .toBe(true);
          const scroll = container.querySelector<HTMLElement>(".chat-comment-preview__scroll")!;
          expect(scroll.clientHeight).toBeGreaterThan(0);
          expect(scroll.clientHeight).toBeLessThanOrEqual(360);
          if (count === 10) {
            expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
            scroll.scrollTop = scroll.scrollHeight;
            expect(scroll.scrollTop).toBeGreaterThan(0);
          }
          const row = container.querySelector(".chat-comment-preview__item")!;
          const passages = row.querySelectorAll<HTMLElement>(".chat-comment-preview__text");
          const selection = passages[0]!;
          const comment = passages[1]!;
          expect(selection.getBoundingClientRect().height).toBeLessThanOrEqual(
            Number.parseFloat(getComputedStyle(selection).lineHeight) + 1,
          );
          expect(comment.getBoundingClientRect().height).toBeLessThanOrEqual(
            Number.parseFloat(getComputedStyle(comment).lineHeight) * 4 + 1,
          );
          const nativeTooltip = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
          const hidden = new Promise<Event>((resolve) => {
            nativeTooltip.addEventListener("wa-after-hide", resolve, { once: true });
          });
          await userEvent.keyboard("{Escape}");
          await hidden;
          await expect.poll(() => tooltip.hasAttribute("open")).toBe(false);
          trigger.blur();
        }
      }
    },
  );
});

function openEditor(expanded = false) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onDelete = vi.fn();
  showChatAnnotationEditor({
    anchorRect: new DOMRect(120, 120, 100, 20),
    comment: "",
    expanded,
    onSave,
    onCancel,
    onDelete,
  });
  return {
    input: document.querySelector<HTMLTextAreaElement>(".chat-annotation-editor textarea")!,
    popup: document.querySelector<HTMLElement>(".chat-annotation-editor")!,
    onSave,
    onCancel,
    onDelete,
  };
}

describe("annotation editor", () => {
  it.each(["light", "dark"])("keeps creation and edit focus frames subtle in %s", async (theme) => {
    document.documentElement.dataset.themeMode = theme;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const expectNonRed = (color: string) => {
      context.fillStyle = "white";
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      if (alpha) {
        expect(red! - Math.max(green!, blue!)).toBeLessThanOrEqual(8);
      }
    };
    const expectQuietFrame = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      expect(Number.parseFloat(style.borderTopWidth)).toBeLessThanOrEqual(1);
      if (Number.parseFloat(style.borderTopWidth) > 0) {
        expectNonRed(style.borderTopColor);
      }
      if (style.outlineStyle !== "none") {
        expect(Number.parseFloat(style.outlineWidth)).toBeLessThanOrEqual(1);
        expectNonRed(style.outlineColor);
      }
      for (const color of style.boxShadow.match(/(?:rgba?|color)\([^)]*\)/g) ?? []) {
        expectNonRed(color);
      }
    };
    for (const expanded of [false, true]) {
      const { input, popup } = openEditor(expanded);
      input.blur();
      const idleBorder = getComputedStyle(popup).borderTopColor;
      const controls = [input, ...popup.querySelectorAll("button")].filter(
        (element) => element.getClientRects().length > 0,
      );
      for (const element of [popup, ...controls]) {
        expectQuietFrame(element);
      }
      await userEvent.keyboard("{ArrowRight}");
      for (const control of controls) {
        await page.elementLocator(control).hover();
        expectQuietFrame(control);
        control.focus();
        expect(control.matches(":focus-visible")).toBe(true);
        expectQuietFrame(popup);
        expectQuietFrame(control);
        if (control === input) {
          expect(getComputedStyle(popup).borderTopColor).not.toBe(idleBorder);
        } else {
          expect(Number.parseFloat(getComputedStyle(control).outlineWidth)).toBeGreaterThan(0);
        }
      }
      removeChatSelectionPopup();
    }
  });

  it.each(["Cancel", "Delete comment"])(
    "activates %s with Enter without saving edits",
    async (name) => {
      const { input, popup, onSave, onCancel, onDelete } = openEditor(true);
      await page.elementLocator(input).fill("Unsaved replacement");
      const control = page.getByRole("button", { name, exact: true });
      control.element().focus();
      await userEvent.keyboard("{Enter}");
      expect(onSave).not.toHaveBeenCalled();
      expect(name === "Cancel" ? onCancel : onDelete).toHaveBeenCalledOnce();
      expect(name === "Cancel" ? onDelete : onCancel).not.toHaveBeenCalled();
      expect(popup.isConnected).toBe(false);
    },
  );

  it.each([1440, 390])(
    "grows downward from one line to five, then scrolls (%ipx)",
    async (width) => {
      await page.viewport(width, 900);
      const { input, popup } = openEditor();
      const oneLine = input.getBoundingClientRect().height;
      const originalTop = popup.getBoundingClientRect().top;
      const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
      await page.elementLocator(input).fill("First line\nSecond line\nThird line");
      await expect
        .poll(() => input.getBoundingClientRect().height)
        .toBeGreaterThan(oneLine + lineHeight);
      expect(input.placeholder).toBe("Add an optional comment…");
      expect(popup.getBoundingClientRect().top).toBeCloseTo(originalTop, 0);
      await page.elementLocator(input).fill("One\nTwo\nThree\nFour\nFive\nSix\nSeven");
      await expect.poll(() => input.scrollHeight).toBeGreaterThan(input.clientHeight);
      expect(input.getBoundingClientRect().height).toBeLessThanOrEqual(
        oneLine + lineHeight * 4 + 1,
      );
      input.scrollTop = input.scrollHeight;
      expect(input.scrollTop).toBeGreaterThan(0);
      expect(popup.getBoundingClientRect().top).toBeCloseTo(originalTop, 0);
      expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
    },
  );

  it.each([false, true])(
    "supports Enter, Shift+Enter and Escape (editing=%s)",
    async (expanded) => {
      const { input, popup, onSave, onCancel } = openEditor(expanded);
      await page.elementLocator(input).fill("First");
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      expect(input.value).toBe("First\n");
      expect(onSave).not.toHaveBeenCalled();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
      expect(onSave).not.toHaveBeenCalled();
      await userEvent.keyboard("{Enter}");
      expect(onSave).toHaveBeenCalledExactlyOnceWith("First\n");
      expect(popup.isConnected).toBe(false);
      expect(onCancel).not.toHaveBeenCalled();
      const cancelled = openEditor(expanded);
      await page.elementLocator(cancelled.input).fill("Discard this draft");
      await userEvent.keyboard("{Escape}");
      expect(cancelled.onSave).not.toHaveBeenCalled();
      expect(cancelled.onCancel).toHaveBeenCalledOnce();
      expect(cancelled.popup.isConnected).toBe(false);
    },
  );
});
