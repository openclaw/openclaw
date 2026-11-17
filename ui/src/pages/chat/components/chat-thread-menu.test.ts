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

afterEach(() => {
  resetThreadPresentation();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
