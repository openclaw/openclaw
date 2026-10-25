// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import {
  getChatAttachmentDataUrl,
  releaseChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { chatAttachmentFromDataUrl } from "./chat-attachments.ts";
import { replaceRedactedAttachment } from "./chat-image-redaction.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhZkAAAAASUVORK5CYII=";
const owned = new Set<string>();
afterEach(() => {
  for (const id of owned) {
    releaseChatAttachmentPayload(id);
  }
  owned.clear();
});
function attachment(name: string) {
  const value = chatAttachmentFromDataUrl(png, name, undefined, 0);
  if (!value) {
    throw new Error("fixture attachment was not admitted");
  }
  owned.add(value.id);
  return value;
}

describe("redacted draft attachment admission", () => {
  it("replaces in place with independent payload custody and leaves its sibling intact", () => {
    const original = attachment("private.jpg");
    const sibling = attachment("keep.png");
    let current = [sibling, original];
    expect(
      replaceRedactedAttachment(original, png, {
        getAttachments: () => current,
        onAttachmentsChange: (next) => {
          current = next;
        },
      }),
    ).toBe(true);
    const replacement = current[1]!;
    owned.add(replacement.id);
    expect(replacement).toMatchObject({ fileName: "private-redacted.png", mimeType: "image/png" });
    expect(replacement.id).not.toBe(original.id);
    expect(current[0]).toBe(sibling);
    expect(getChatAttachmentDataUrl(original)).toBeNull();
    expect(getChatAttachmentDataUrl(sibling)).toBe(png);
    expect(getChatAttachmentDataUrl(replacement)).toBe(png);
  });

  it("does not destroy the source when the destination rejects publication", () => {
    const original = attachment("private.png");
    let rejected: ChatAttachment | undefined;
    expect(
      replaceRedactedAttachment(original, png, {
        attachments: [original],
        onAttachmentsChange: (next) => {
          rejected = next[0];
          return false;
        },
      }),
    ).toBe(false);
    expect(rejected).toBeDefined();
    expect(getChatAttachmentDataUrl(rejected!)).toBeNull();
    expect(getChatAttachmentDataUrl(original)).toBe(png);
  });

  it("accounts for retained sibling bytes when admitting the replacement", () => {
    const original = attachment("private.png");
    const sibling = attachment("keep.png");
    const onAttachmentsChange = vi.fn();
    expect(
      replaceRedactedAttachment(original, png, {
        attachments: [original, sibling],
        onAttachmentsChange,
        attachmentLimits: {
          maxBytes: 1000,
          maxImageBytes: 1000,
          maxBatchBytes: original.sizeBytes!,
        },
      }),
    ).toBe(false);
    expect(onAttachmentsChange).not.toHaveBeenCalled();
    expect(getChatAttachmentDataUrl(original)).toBe(png);
  });

  it.each(["aborted", "disabled", "removed", "parked"])(
    "rejects an edit after the draft is %s",
    (state) => {
      const original = attachment("private.png");
      const controller = new AbortController();
      if (state === "aborted") {
        controller.abort();
      }
      const onAttachmentsChange = vi.fn();
      expect(
        replaceRedactedAttachment(original, png, {
          attachments: state === "removed" ? [] : [original],
          readSignal: controller.signal,
          disabled: state === "disabled",
          cameraActive: state !== "parked",
          onAttachmentsChange,
        }),
      ).toBe(false);
      expect(onAttachmentsChange).not.toHaveBeenCalled();
      expect(getChatAttachmentDataUrl(original)).toBe(png);
    },
  );
});
