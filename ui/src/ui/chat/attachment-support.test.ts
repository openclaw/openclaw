import { describe, expect, it } from "vitest";

import {
  isSupportedChatAttachmentMimeType,
  resolveSupportedChatAttachmentMimeType,
} from "./attachment-support.ts";

describe("attachment support", () => {
  it("accepts image mime types directly", () => {
    expect(isSupportedChatAttachmentMimeType("image/png")).toBe(true);
    expect(resolveSupportedChatAttachmentMimeType({ name: "photo.png", type: "image/png" })).toBe(
      "image/png",
    );
  });

  it("falls back to supported file extensions when drag/drop mime type is empty", () => {
    expect(resolveSupportedChatAttachmentMimeType({ name: "photo.png", type: "" })).toBe(
      "image/png",
    );
    expect(resolveSupportedChatAttachmentMimeType({ name: "photo.JPEG", type: "" })).toBe(
      "image/jpeg",
    );
    expect(resolveSupportedChatAttachmentMimeType({ name: "photo.webp", type: null })).toBe(
      "image/webp",
    );
  });

  it("rejects unsupported files when mime type and extension are both missing or non-image", () => {
    expect(resolveSupportedChatAttachmentMimeType({ name: "notes.txt", type: "" })).toBeNull();
    expect(resolveSupportedChatAttachmentMimeType({ name: "", type: "" })).toBeNull();
    expect(
      resolveSupportedChatAttachmentMimeType({ name: "report.png", type: "application/pdf" }),
    ).toBeNull();
    expect(isSupportedChatAttachmentMimeType("application/pdf")).toBe(false);
  });
});
