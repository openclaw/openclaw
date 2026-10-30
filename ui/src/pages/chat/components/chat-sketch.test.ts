// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { chatAttachmentFromDataUrl } from "./chat-attachments.ts";
import { attachChatSketch } from "./chat-sketch.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=";
const owned = new Set<string>();
afterEach(() => {
  for (const id of owned) {
    releaseChatAttachmentPayload(id);
  }
  owned.clear();
});
describe("sketch attachment admission", () => {
  it("stages an ordinary PNG without replacing an existing attachment", () => {
    const original = chatAttachmentFromDataUrl(png, "keep.png", undefined, 0)!;
    owned.add(original.id);
    let current = [original];
    expect(
      attachChatSketch(png, {
        getAttachments: () => current,
        onAttachmentsChange: (next) => {
          current = next;
        },
      }),
    ).toBe(true);
    const sketch = current[1]!;
    owned.add(sketch.id);
    expect(current[0]).toBe(original);
    expect(sketch).toMatchObject({ fileName: "sketch.png", mimeType: "image/png" });
    expect(sketch.browserAnnotation).toBeUndefined();
    expect(getChatAttachmentDataUrl(sketch)).toBe(png);
  });
  it("releases an attachment rejected by the destination", () => {
    let rejected: ChatAttachment | undefined;
    expect(
      attachChatSketch(png, {
        attachments: [],
        onAttachmentsChange: (next) => {
          rejected = next[0];
          return false;
        },
      }),
    ).toBe(false);
    expect(rejected).toBeDefined();
    expect(getChatAttachmentDataUrl(rejected!)).toBeNull();
  });
  it("preserves the file and batch limits", () => {
    const onAttachmentsChange = vi.fn();
    expect(
      attachChatSketch(png, {
        attachments: [],
        onAttachmentsChange,
        attachmentLimits: { maxBytes: 1, maxImageBytes: 1, maxBatchBytes: 1 },
      }),
    ).toBe(false);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
  it.each(["disabled", "aborted", "parked"])("does not stage into a %s composer", (state) => {
    const controller = new AbortController();
    if (state === "aborted") {
      controller.abort();
    }
    const onAttachmentsChange = vi.fn();
    expect(
      attachChatSketch(png, {
        attachments: [],
        onAttachmentsChange,
        disabled: state === "disabled",
        readSignal: controller.signal,
        cameraActive: state !== "parked",
      }),
    ).toBe(false);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
  });
});
