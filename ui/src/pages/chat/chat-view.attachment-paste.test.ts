// @vitest-environment jsdom

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { createChatProps, createPasteEvent } from "./chat-view.test-helpers.ts";
import { renderChat } from "./chat-view.ts";
import { resetTranscriptTestDom } from "./components/chat-transcript.test-support.ts";

const payloads: ChatAttachment[] = [];

afterEach(() => {
  releaseChatAttachmentPayloads(payloads.splice(0));
  resetChatViewState();
  resetTranscriptTestDom();
});

function renderChatView(overrides: Partial<Parameters<typeof renderChat>[0]>) {
  const container = document.createElement("div");
  render(
    renderChat(
      createChatProps({
        ...overrides,
        onAttachmentsChange: (attachments) => {
          payloads.push(...attachments);
          overrides.onAttachmentsChange?.(attachments);
        },
      }),
    ),
    container,
  );
  return container;
}

function getComposerTextarea(container: Element) {
  return expectDefined(
    container.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea"),
    "composer textarea",
  );
}

describe("chat attachment paste", () => {
  it("converts supported-size pasted image bytes into an attachment", () => {
    const onAttachmentsChange = vi.fn<(attachments: ChatAttachment[]) => void>();
    const container = renderChatView({ onAttachmentsChange });
    const textarea = getComposerTextarea(container);
    const base64 = Buffer.alloc(4 * 1024 * 1024, 0xab).toString("base64");
    const allowed = textarea.dispatchEvent(createPasteEvent(`data:image/png;base64,${base64}`, []));
    expect(allowed).toBe(false);
    const attachments = expectDefined(onAttachmentsChange.mock.calls[0]?.[0], "pasted attachments");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.sizeBytes).toBe(4 * 1024 * 1024);
    expect(getChatAttachmentDataUrl(expectDefined(attachments[0], "pasted image"))).toBe(
      `data:image/png;base64,${base64}`,
    );
  });

  it.each(["AA$A", "QQ=Q", "===="])(
    "leaves invalid pasted image bytes %s out of attachments",
    (data) => {
      const onAttachmentsChange = vi.fn<(attachments: ChatAttachment[]) => void>();
      const container = renderChatView({ onAttachmentsChange });
      getComposerTextarea(container).dispatchEvent(
        createPasteEvent(`data:image/png;base64,${data}`, []),
      );
      expect(onAttachmentsChange).not.toHaveBeenCalled();
    },
  );
});
