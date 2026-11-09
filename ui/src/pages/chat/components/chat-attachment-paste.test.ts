import { expect, it, vi } from "vitest";
import { handleChatAttachmentPaste } from "./chat-attachments.ts";

it.each(["", "Review this plan:\n"])(
  "keeps an empty draft inline and collapses a long paste beside an existing draft %j",
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

    expect(event.defaultPrevented).toBe(Boolean(draft));
    if (draft) {
      expect(onAttachmentsChange).toHaveBeenCalledWith([
        expect.objectContaining({ origin: "paste", mimeType: "text/plain" }),
      ]);
    } else {
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    }
  },
);
