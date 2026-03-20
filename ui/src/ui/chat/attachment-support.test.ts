// Authored by: cc (Claude Code) | 2026-03-20
import { describe, expect, it } from "vitest";
import { CHAT_ATTACHMENT_ACCEPT, isSupportedChatAttachmentMimeType } from "./attachment-support.ts";

describe("isSupportedChatAttachmentMimeType", () => {
  it("accepts image types", () => {
    expect(isSupportedChatAttachmentMimeType("image/jpeg")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("image/png")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("image/webp")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("image/gif")).toBe(true);
  });

  it("accepts PDF", () => {
    expect(isSupportedChatAttachmentMimeType("application/pdf")).toBe(true);
  });

  it("accepts supported text file types", () => {
    expect(isSupportedChatAttachmentMimeType("text/plain")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("text/csv")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("text/markdown")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("text/html")).toBe(true);
    expect(isSupportedChatAttachmentMimeType("application/json")).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isSupportedChatAttachmentMimeType("application/zip")).toBe(false);
    expect(isSupportedChatAttachmentMimeType("video/mp4")).toBe(false);
    expect(isSupportedChatAttachmentMimeType("application/octet-stream")).toBe(false);
  });

  it("rejects null, undefined, empty string", () => {
    expect(isSupportedChatAttachmentMimeType(null)).toBe(false);
    expect(isSupportedChatAttachmentMimeType(undefined)).toBe(false);
    expect(isSupportedChatAttachmentMimeType("")).toBe(false);
  });
});

describe("CHAT_ATTACHMENT_ACCEPT", () => {
  it("includes image/*", () => {
    expect(CHAT_ATTACHMENT_ACCEPT).toContain("image/*");
  });

  it("includes application/pdf", () => {
    expect(CHAT_ATTACHMENT_ACCEPT).toContain("application/pdf");
  });

  it("includes text/plain and text/csv", () => {
    expect(CHAT_ATTACHMENT_ACCEPT).toContain("text/plain");
    expect(CHAT_ATTACHMENT_ACCEPT).toContain("text/csv");
  });
});
