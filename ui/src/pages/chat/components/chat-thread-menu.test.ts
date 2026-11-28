/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  createRichTooltip,
  dispatchMousePointer,
  hoverTrigger,
  settleTooltip,
} from "../../../components/tooltip.test-support.ts";
import { restorePropertyDescriptor } from "../../../test-helpers/property-descriptor.ts";
import {
  handleTranscriptContextMenu,
  resetThreadPresentation,
} from "./chat-thread-interactions.ts";
import { moveThreadMenuFocus } from "./chat-thread-menu.tsx";

afterEach(() => {
  resetThreadPresentation();
  document.body.replaceChildren();
  // Unstub before uninstalling the fake clock so its frame function cannot leak.
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("closes the message menu on Escape after a previous hover tooltip finishes loading", async () => {
  vi.useFakeTimers();
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const { tooltip, trigger } = createRichTooltip("Stop Escape", "Stop");
  document.body.append(tooltip);
  await settleTooltip(tooltip);
  hoverTrigger(trigger);
  vi.advanceTimersByTime(150);
  dispatchMousePointer(trigger, "pointerleave");

  const bubble = document.body.appendChild(document.createElement("div"));
  bubble.className = "chat-bubble";
  Object.assign(bubble, { messageActions: { copyMarkdown: "Synthetic message" } });
  bubble.addEventListener("contextmenu", (event) =>
    handleTranscriptContextMenu(event, { paneId: "hover-escape-menu" }),
  );
  bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const button = expectDefined(
    document.querySelector<HTMLButtonElement>('.chat-reply-context-menu [role="menuitem"]'),
    "message action",
  );
  expect(document.activeElement).toBe(button);
  // The old hover's renderer resolves after the menu has taken focus.
  await settleTooltip(tooltip);
  for (const callback of frames.splice(0)) {
    callback(0);
  }
  button.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(button.isConnected).toBe(false);
});

it("lets Escape close the message menu before the first animation frame", () => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const onFocusComposer = vi.fn();
  const bubble = document.body.appendChild(document.createElement("div"));
  bubble.className = "chat-bubble";
  Object.assign(bubble, { messageActions: { copyMarkdown: "Synthetic message" } });
  bubble.addEventListener("contextmenu", (event) =>
    handleTranscriptContextMenu(event, { paneId: "escape-menu", onFocusComposer }),
  );
  bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const button = expectDefined(
    document.querySelector<HTMLButtonElement>('.chat-reply-context-menu [role="menuitem"]'),
    "message action",
  );
  expect(document.activeElement).toBe(button);
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  button.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(button.isConnected).toBe(false);
  expect(onFocusComposer).toHaveBeenCalledOnce();
});

function mountMenuKeyboardFixture(options: { runWorking?: boolean } = {}) {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  });
  const group = document.body.appendChild(document.createElement("div"));
  group.className = "chat-group user";
  const bubble = group.appendChild(document.createElement("div"));
  bubble.className = "chat-bubble";
  bubble.dataset.entryId = "entry-1";
  bubble.dataset.messageId = "message-1";
  Object.assign(bubble, {
    messageActions: { replyTarget: { messageId: "message-1", text: "hello" } },
  });
  const props = {
    paneId: "menu-keyboard",
    onSetReply: vi.fn(),
    onRewindMessage: vi.fn(() => true),
    onForkMessage: vi.fn(),
    ...(options.runWorking ? { runWorking: true } : {}),
  };
  bubble.addEventListener("contextmenu", (event) => handleTranscriptContextMenu(event, props));
  bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const items = [
    ...document.querySelectorAll<HTMLButtonElement>(
      '.chat-reply-context-menu button[role="menuitem"]',
    ),
  ];
  return { bubble, items, props };
}

function press(key: string) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

it("moves menu focus with Arrow keys, Home, and End with wrapping", () => {
  const { items } = mountMenuKeyboardFixture();

  expect(items.map((button) => button.textContent?.trim())).toEqual([
    "Reply",
    "Rewind to here",
    "Fork from here",
  ]);
  expect(document.activeElement).toBe(items[0]);

  press("ArrowDown");
  expect(document.activeElement).toBe(items[1]);
  press("ArrowDown");
  expect(document.activeElement).toBe(items[2]);
  press("ArrowDown");
  expect(document.activeElement).toBe(items[0]);
  press("ArrowUp");
  expect(document.activeElement).toBe(items[2]);
  press("Home");
  expect(document.activeElement).toBe(items[0]);
  press("End");
  expect(document.activeElement).toBe(items[2]);
});

it("skips disabled menu items and wraps around them", () => {
  const menu = document.body.appendChild(document.createElement("div"));
  menu.setAttribute("role", "menu");
  const buttons = ["Reply", "Rewind", "Fork"].map((label, index) => {
    const button = menu.appendChild(document.createElement("button"));
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.disabled = index === 1;
    return button;
  });
  const [reply, , fork] = buttons.map((button) => expectDefined(button, "menu item"));

  reply.focus();
  expect(moveThreadMenuFocus(menu, "ArrowDown")).toBe(true);
  expect(document.activeElement).toBe(fork);
  expect(moveThreadMenuFocus(menu, "ArrowUp")).toBe(true);
  expect(document.activeElement).toBe(reply);
  expect(moveThreadMenuFocus(menu, "Escape")).toBe(false);
});

it("dismisses the menu on Tab", () => {
  mountMenuKeyboardFixture();

  expect(document.querySelector(".chat-reply-context-menu")).not.toBeNull();
  press("Tab");
  expect(document.querySelector(".chat-reply-context-menu")).toBeNull();
});

it("keeps failed context-copy feedback visible and retries before dismissing the menu", async () => {
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("Clipboard denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const fallbackDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  onTestFinished(() => {
    restorePropertyDescriptor(document, "execCommand", fallbackDescriptor);
  });
  const group = document.body.appendChild(document.createElement("div"));
  group.className = "chat-group assistant";
  const bubble = group.appendChild(document.createElement("div"));
  bubble.className = "chat-bubble";
  Object.assign(bubble, { messageActions: { copyMarkdown: "Synthetic commentary" } });
  bubble.addEventListener("contextmenu", (event) =>
    handleTranscriptContextMenu(event, { paneId: "copy-feedback" }),
  );

  bubble.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const button = expectDefined(
    document.querySelector<HTMLButtonElement>(".chat-reply-context-menu button"),
    "context copy action",
  );
  expect(button.textContent?.trim()).toBe("Copy as markdown");
  button.click();
  await vi.waitFor(() => expect(button.textContent?.trim()).toBe("Couldn’t copy. Try again."));
  expect(button.isConnected).toBe(true);
  button.click();
  await vi.waitFor(() => expect(button.isConnected).toBe(false));
  expect(writeText).toHaveBeenNthCalledWith(1, "Synthetic commentary");
  expect(writeText).toHaveBeenNthCalledWith(2, "Synthetic commentary");
});

it("keeps native animation frames working after menu mocks are restored", async () => {
  let delivered = false;
  const frame = requestAnimationFrame(() => {
    delivered = true;
  });
  onTestFinished(() => cancelAnimationFrame(frame));
  await vi.waitFor(() => expect(delivered).toBe(true));
});
