import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "../../../styles/chat/composer.css";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { ChatCommentPins } from "./chat-comment-pins.tsx";
import { CommentPreviewChip, CommentPreviewRow } from "./chat-comment-preview.tsx";
import { removeChatSelectionPopup, showChatAnnotationEditor } from "./chat-selection-popup.tsx";
import { createTranscriptMessageElements } from "./chat-transcript-message-elements.ts";

const longSelection = "Selected passage with enough words to exceed a compact preview. ".repeat(8);
const longComment =
  "Please verify the deployment checklist and retain the original context. ".repeat(24);
let container: HTMLDivElement;
let comments: ReturnType<typeof mountSolid> | undefined;
let originalTheme: { theme: string | undefined; themeMode: string | undefined };
const query = <T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = container,
) => root.querySelector<T>(selector)!;
const preview = (part: string) => query(`.chat-comment-preview__${part}`);
const rect = (element: Element) => element.getBoundingClientRect();
const once = (element: EventTarget, type: string) =>
  new Promise<Event>((resolve) => {
    element.addEventListener(type, resolve, { once: true });
  });

beforeEach(async () => {
  const { theme, themeMode } = document.documentElement.dataset;
  originalTheme = { theme, themeMode };
  await page.viewport(1440, 900);
  container = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  removeChatSelectionPopup();
  comments?.unmount();
  comments = undefined;
  container.remove();
  for (const [key, value] of Object.entries(originalTheme)) {
    if (value === undefined) {
      delete document.documentElement.dataset[key];
    } else {
      document.documentElement.dataset[key] = value;
    }
  }
});

function mountComments(count: number, top: number) {
  container.style.cssText = `position: fixed; right: 16px; top: ${top}px`;
  comments?.unmount();
  comments = mountSolid(
    () => (
      <CommentPreviewChip count={count}>
        <ol class="chat-comment-preview__list" role="list">
          {Array.from({ length: count }, () => (
            <CommentPreviewRow comment={{ text: longSelection, comment: longComment }} />
          ))}
        </ol>
      </CommentPreviewChip>
    ),
    { container },
  );
  flush();
  return query(".chat-selection-annotations__chip");
}

async function openComments(trigger: HTMLElement) {
  const tooltip = container.querySelector("openclaw-tooltip")!;
  await tooltip.updateComplete;
  const shown = once(tooltip, "overlay-after-show");
  trigger.focus();
  await shown;
  const body = query(".tooltip-surface", tooltip.shadowRoot!);
  await expect.poll(() => body.matches(":popover-open")).toBe(true);
  await expect.poll(() => rect(body).height).toBeGreaterThan(0);
  return { tooltip, body };
}

function colorSampler() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  return (color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data;
  };
}

function contrast(element: HTMLElement) {
  const sample = colorSampler();
  const ancestors: HTMLElement[] = [];
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    ancestors.unshift(current);
  }
  let pixels = sample("white");
  for (const ancestor of ancestors) {
    pixels = sample(getComputedStyle(ancestor).backgroundColor);
  }
  const luminance = (rgba: Uint8ClampedArray) => {
    const linear = Array.from(rgba.slice(0, 3), (channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const background = luminance(pixels);
  const foreground = luminance(sample(getComputedStyle(element).color));
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
}

it.each([1440, 390])("reads the final comment line by keyboard (%ipx)", async (width) => {
  await page.viewport(width, 900);
  const trigger = mountComments(10, 430);
  const { tooltip } = await openComments(trigger);
  const comment = preview("text--comment");
  await userEvent.tab();
  await userEvent.tab();
  expect(document.activeElement).toBe(comment);
  const scrolled = once(comment, "scrollend");
  await userEvent.keyboard("{End}");
  await scrolled;
  await expect
    .poll(() => comment.scrollTop + comment.clientHeight)
    .toBeGreaterThanOrEqual(comment.scrollHeight - 1);
  const text = comment.firstChild!;
  const lastWord = document.createRange();
  lastWord.setStart(text, text.textContent!.length - 8);
  lastWord.setEnd(text, text.textContent!.length);
  const bounds = rect(comment);
  expect(lastWord.getBoundingClientRect().top).toBeGreaterThanOrEqual(bounds.top);
  expect(lastWord.getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom + 1);
  await userEvent.keyboard("{Home}");
  await expect.poll(() => comment.scrollTop).toBe(0);
  expect(tooltip.hasAttribute("open")).toBe(true);
});

it.each(["light", "dark"])("keeps attachment-chip text readable in %s", async (theme) => {
  document.documentElement.dataset.themeMode = theme;
  const trigger = mountComments(3, 450);
  await container.querySelector("openclaw-tooltip")!.updateComplete;
  await expect.poll(() => rect(trigger).width).toBeGreaterThan(0);
  expect(trigger.classList.contains("chat-attachment-thumb")).toBe(true);
  expect(trigger.classList.contains("chat-attachment-thumb--file")).toBe(true);
  const text = query(".chat-attachment-file", trigger);
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

it.each([1440, 390])("bounds 1, 3 and 10 comments at viewport edges (%ipx)", async (width) => {
  await page.viewport(width, 900);
  for (const count of [1, 3, 10]) {
    for (const top of [12, 430, 840]) {
      const trigger = mountComments(count, top);
      const { tooltip, body } = await openComments(trigger);
      await expect
        .poll(() => {
          const card = rect(body);
          const anchor = rect(trigger);
          return (
            card.left >= 0 &&
            card.right <= window.innerWidth &&
            card.top >= 0 &&
            card.bottom <= window.innerHeight &&
            (card.bottom <= anchor.top || card.top >= anchor.bottom)
          );
        })
        .toBe(true);
      const scroll = preview("scroll");
      expect(scroll.clientHeight).toBeGreaterThan(0);
      expect(scroll.clientHeight).toBeLessThanOrEqual(360);
      if (count === 10) {
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        scroll.scrollTop = scroll.scrollHeight;
        expect(scroll.scrollTop).toBeGreaterThan(0);
      }
      const list = preview("list");
      const rows = list.querySelectorAll(":scope > .chat-comment-preview__item");
      expect(rows).toHaveLength(count);
      const following = list.querySelectorAll(
        ".chat-comment-preview__item + .chat-comment-preview__item",
      );
      expect(following).toHaveLength(count - 1);
      const row = rows[0]!;
      if (count > 1) {
        expect(getComputedStyle(rows[1]!).marginTop).toBe("12px");
        expect(rect(rows[1]!).top - rect(row).bottom).toBeCloseTo(12, 0);
      }
      const passages = row.querySelectorAll<HTMLElement>(".chat-comment-preview__text");
      for (const [index, lines] of [1, 4].entries()) {
        const passage = passages[index]!;
        expect(rect(passage).height).toBeLessThanOrEqual(
          Number.parseFloat(getComputedStyle(passage).lineHeight) * lines + 1,
        );
      }
      const hidden = once(tooltip, "overlay-after-hide");
      await userEvent.keyboard("{Escape}");
      await hidden;
      await expect.poll(() => tooltip.hasAttribute("open")).toBe(false);
      trigger.blur();
    }
  }
});

function openEditor(expanded = false) {
  const callbacks = { onSave: vi.fn(), onCancel: vi.fn(), onDelete: vi.fn() };
  showChatAnnotationEditor({
    paneId: "pane-a",
    anchorRect: new DOMRect(120, 120, 100, 20),
    comment: "",
    expanded,
    ...callbacks,
  });
  const popup = query(".chat-annotation-editor", document);
  return { input: query<HTMLTextAreaElement>("textarea", popup), popup, ...callbacks };
}

it.each(["light", "dark"])("keeps editor focus frames subtle in %s", async (theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = theme;
  await page.elementLocator(document.body).hover({ position: { x: 2, y: 2 } });
  const sample = colorSampler();
  const expectNonRed = (color: string, surface: string) => {
    sample("white");
    const [red, green, blue, alpha] = sample(color);
    if (alpha) {
      expect(red! - Math.max(green!, blue!), `${surface}: ${color}`).toBeLessThanOrEqual(8);
    }
  };
  const expectQuietFrame = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    const surface = `${element.localName}.${element.className}`;
    expect(Number.parseFloat(style.borderTopWidth)).toBeLessThanOrEqual(1);
    if (Number.parseFloat(style.borderTopWidth) > 0) {
      expectNonRed(style.borderTopColor, `${surface} border`);
    }
    if (style.outlineStyle !== "none") {
      expect(Number.parseFloat(style.outlineWidth)).toBeLessThanOrEqual(1);
      expectNonRed(style.outlineColor, `${surface} outline`);
    }
    for (const color of style.boxShadow.match(/(?:rgba?|color)\([^)]*\)/g) ?? []) {
      expectNonRed(color, `${surface} shadow`);
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

it.each(["Cancel", "Delete comment"])("activates %s without saving", async (name) => {
  const { input, popup, onSave, onCancel, onDelete } = openEditor(true);
  await page.elementLocator(input).fill("Unsaved replacement");
  const control = page.getByRole("button", { name, exact: true });
  control.element().focus();
  await userEvent.keyboard("{Enter}");
  expect(onSave).not.toHaveBeenCalled();
  expect(name === "Cancel" ? onCancel : onDelete).toHaveBeenCalledOnce();
  expect(name === "Cancel" ? onDelete : onCancel).not.toHaveBeenCalled();
  expect(popup.isConnected).toBe(false);
});

it.each([
  { width: 1440, expanded: false },
  { width: 390, expanded: false },
  { width: 1440, expanded: true },
  { width: 390, expanded: true },
])(
  "grows, caps and scrolls unfaded text ($width px, editing=$expanded)",
  async ({ width, expanded }) => {
    await page.viewport(width, 900);
    const { input, popup } = openEditor(expanded);
    const oneLine = rect(input).height;
    const originalTop = rect(popup).top;
    const lineHeight = Number.parseFloat(getComputedStyle(input).lineHeight);
    await page.elementLocator(input).fill("First line\nSecond line\nThird line");
    await expect.poll(() => rect(input).height).toBeGreaterThan(oneLine + lineHeight);
    expect(input.placeholder).toBe("Add an optional comment…");
    expect(rect(popup).top).toBeCloseTo(originalTop, 0);
    await page.elementLocator(input).fill("One\nTwo\nThree\nFour\nFive\nSix\nSeven");
    await expect.poll(() => input.scrollHeight).toBeGreaterThan(input.clientHeight);
    expect(rect(input).height).toBeLessThanOrEqual(oneLine + lineHeight * 4 + 1);
    for (const scrollTop of [
      0,
      (input.scrollHeight - input.clientHeight) / 2,
      input.scrollHeight,
    ]) {
      input.scrollTop = scrollTop;
      input.dispatchEvent(new Event("scroll"));
      expect(getComputedStyle(input).maskImage).toBe("none");
    }
    expect(input.scrollTop).toBeGreaterThan(0);
    expect(rect(popup).top).toBeCloseTo(originalTop, 0);
    expect(rect(popup).right).toBeLessThanOrEqual(window.innerWidth);
  },
);

it.each([false, true])("supports Enter, Shift+Enter and Escape (editing=%s)", async (expanded) => {
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
});
it("relayouts for content that can move a placed source, not content after it", async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  // Resize delivery is asynchronous in a real browser; this test isolates mutations.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  onTestFinished(() => vi.unstubAllGlobals());
  container.innerHTML = `<div class="chat-thread" style="height: 600px">
      <div class="chat-thread-inner">
        <div class="chat-bubble" data-entry-id="before">Earlier context</div>
        <div class="chat-bubble" data-entry-id="source">Selected passage</div>
        <div class="chat-bubble" data-entry-id="after">Streaming reply</div>
      </div>
    </div>`;
  const thread = query(".chat-thread");
  const bubble = (entryId: string) => query(`.chat-bubble[data-entry-id="${entryId}"]`, thread);
  const before = bubble("before");
  const source = bubble("source");
  const after = bubble("after");
  const messageElements = createTranscriptMessageElements(() => undefined);
  messageElements.forKey("source")(source);
  onTestFinished(() => messageElements.dispose());
  const pins = new ChatCommentPins.Element();
  pins.transcript = {
    messageElements,
    contentElement: query<HTMLDivElement>(".chat-thread-inner", thread),
  };
  pins.attachments = [
    {
      id: "comment",
      mimeType: "text/plain",
      selectionAnnotation: {
        text: "Selected passage",
        comment: "Check this",
        sessionKey: "main",
        entryId: "source",
        start: 0,
        end: 16,
      },
    },
  ];
  pins.sessionKey = "main";
  thread.append(pins);
  const pin = () => query<HTMLButtonElement>("button", pins);
  const layouts = vi.spyOn(pins, "getBoundingClientRect");
  const settle = async () => {
    await pins.updateComplete;
    // Mutation records reach the observer as a microtask.
    await Promise.resolve();
    for (const frame of frames.splice(0)) {
      frame(0);
    }
    const count = layouts.mock.calls.length;
    layouts.mockClear();
    return count;
  };
  expect(await settle()).toBe(1);
  expect(pin().hidden).toBe(false);
  const top = Number.parseFloat(pin().style.top);

  // Streaming below the source cannot move it in the top-aligned transcript.
  after.append(" with more streamed words", document.createElement("p"));
  after.dataset.messageText = "Streaming reply with more streamed words";
  expect(await settle()).toBe(0);
  thread.dispatchEvent(new Event("scroll"));
  expect(await settle()).toBe(1);
  expect(Number.parseFloat(pin().style.top)).toBe(top);

  const spacer = document.createElement("div");
  spacer.style.height = "40px";
  before.append(spacer);
  expect(await settle()).toBe(1);
  expect(Number.parseFloat(pin().style.top)).toBeCloseTo(top + 40, 0);

  source.append(" and its follow-up");
  expect(await settle()).toBe(1);

  // An unplaced pin cannot rule anything out.
  source.remove();
  expect(await settle()).toBe(1);
  expect(pin().hidden).toBe(true);
  after.append(" and more");
  expect(await settle()).toBe(1);
});
