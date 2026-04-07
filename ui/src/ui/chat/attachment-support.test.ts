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

  it("keeps current non-video file mime types directly", () => {
    expect(isSupportedChatAttachmentMimeType("application/pdf")).toBe(true);
    expect(
      resolveSupportedChatAttachmentMimeType({ name: "brief.pdf", type: "application/pdf" }),
    ).toBe("application/pdf");
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

  it("uses an octet fallback for unknown non-video files with missing mime type", () => {
    expect(resolveSupportedChatAttachmentMimeType({ name: "notes.bin", type: "" })).toBe(
      "application/octet-stream",
    );
  });

  it("rejects video mime types and video extensions", () => {
    expect(
      resolveSupportedChatAttachmentMimeType({ name: "photo.png", type: "video/mp4" }),
    ).toBeNull();
    expect(resolveSupportedChatAttachmentMimeType({ name: "clip.mp4", type: "" })).toBeNull();
  });
});
