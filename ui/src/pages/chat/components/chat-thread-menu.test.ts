/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  handleTranscriptContextMenu,
  resetThreadPresentation,
} from "./chat-thread-interactions.ts";

afterEach(() => {
  resetThreadPresentation();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
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
    if (fallbackDescriptor) {
      Object.defineProperty(document, "execCommand", fallbackDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
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
  await vi.waitFor(() => expect(button.textContent?.trim()).toBe("Copy failed"));
  expect(button.isConnected).toBe(true);
  button.click();
  await vi.waitFor(() => expect(button.isConnected).toBe(false));
  expect(writeText).toHaveBeenNthCalledWith(1, "Synthetic commentary");
  expect(writeText).toHaveBeenNthCalledWith(2, "Synthetic commentary");
});
