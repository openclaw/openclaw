/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createComposerProps, resetComposerFixture } from "../chat-composer.test-support.ts";
import { offerFileComment } from "./chat-file-comment.ts";
import { removeChatSelectionPopup } from "./chat-selection-popup.tsx";

afterEach(async () => {
  removeChatSelectionPopup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  await resetComposerFixture();
});

it.each(["permission", "owner", "source"])(
  "does not stage a file comment after its %s retires",
  (change) => {
    const onAttachmentsChange = vi.fn();
    let chat = createComposerProps({ onAttachmentsChange });
    let current = true;
    const source = document.createElement("p");
    source.textContent = "return 3;";
    document.body.append(source);
    const range = document.createRange();
    range.selectNodeContents(source);
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => new DOMRect(100, 100, 80, 20),
    });
    offerFileComment({
      readChat: () => chat,
      selection: {
        text: "return 3;",
        start: 0,
        end: 9,
        file: { path: "retry.ts", startLine: 2, endLine: 2 },
      },
      range,
      signal: new AbortController().signal,
      isCurrent: () => current,
    });
    document.querySelector<HTMLButtonElement>(".chat-selection-popup button")!.click();
    const input = document.querySelector<HTMLTextAreaElement>(".chat-annotation-editor textarea")!;
    expect(input).not.toBeNull();
    input.value = "Change this.";
    if (change === "permission") {
      chat = { ...chat, canCompose: false };
    } else if (change === "owner") {
      chat = { ...chat, sessionKey: "agent:main:other" };
    } else {
      current = false;
    }
    document.querySelector<HTMLButtonElement>(".chat-annotation-editor__confirm")!.click();
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  },
);
