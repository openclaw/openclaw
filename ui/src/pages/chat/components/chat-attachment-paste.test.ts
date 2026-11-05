import { expect, it, vi } from "vitest";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";

it.each(["", "Review this plan:\n"])(
  "keeps a long text paste as native user input with draft %j",
  (draft) => {
    const text = "Keep my instructions as user text. 🦞\n".repeat(50);
    const event = new Event("paste", { cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [], getData: () => text },
    });
    const onAttachmentsChange = vi.fn();

    handleChatAttachmentPaste(event as ClipboardEvent, {
      draft,
      attachments: [],
      onAttachmentsChange,
    });

    expect(event.defaultPrevented).toBe(false);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  },
);
