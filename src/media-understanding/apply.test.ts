import { describe, expect, it } from "vitest";
import { isBinaryMediaMime } from "./apply.js";

describe("isBinaryMediaMime", () => {
  it("returns false for undefined/empty input", () => {
    expect(isBinaryMediaMime(undefined)).toBe(false);
    expect(isBinaryMediaMime("")).toBe(false);
  });

  // Standard media types are always binary.
  it.each([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/heic",
    "audio/ogg",
    "audio/mpeg",
    "audio/wav",
    "video/mp4",
    "video/quicktime",
    "video/webm",
  ])("returns true for standard media type %s", (mime) => {
    expect(isBinaryMediaMime(mime)).toBe(true);
  });

  // application/vnd.* types should be treated as binary (the original bug).
  it.each([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.rar",
    "application/vnd.oasis.opendocument.text",
  ])("returns true for application/vnd.* type %s", (mime) => {
    expect(isBinaryMediaMime(mime)).toBe(true);
  });

  // Other binary application types should also be treated as binary.
  it.each([
    "application/zip",
    "application/gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/octet-stream",
    "application/pdf",
    "application/wasm",
    "application/java-archive",
    "application/x-bzip2",
    "application/x-deb",
    "application/msword",
  ])("returns true for binary application type %s", (mime) => {
    expect(isBinaryMediaMime(mime)).toBe(true);
  });

  // Known text-like application types should NOT be treated as binary.
  it.each([
    "application/json",
    "application/xml",
    "application/javascript",
    "application/x-yaml",
    "application/yaml",
    "application/x-sh",
    "application/x-httpd-php",
    "application/x-perl",
    "application/x-python",
    "application/x-ruby",
    "application/sql",
    "application/graphql",
    "application/ld+json",
    "application/xhtml+xml",
    "application/x-ndjson",
  ])("returns false for text-like application type %s", (mime) => {
    expect(isBinaryMediaMime(mime)).toBe(false);
  });

  // text/* types should never be treated as binary.
  it.each(["text/plain", "text/html", "text/csv", "text/markdown", "text/tab-separated-values"])(
    "returns false for text type %s",
    (mime) => {
      expect(isBinaryMediaMime(mime)).toBe(false);
    },
  );

  // RFC 6839 structured syntax suffixes should be treated as text.
  it.each([
    "application/vnd.api+json",
    "application/hal+json",
    "application/geo+json",
    "application/problem+json",
    "application/vnd.github+json",
    "application/atom+xml",
    "application/rss+xml",
    "application/soap+xml",
    "application/vnd.custom+yaml",
  ])("returns false for structured syntax suffix type %s", (mime) => {
    expect(isBinaryMediaMime(mime)).toBe(false);
  });

  // Handles MIME types with parameters (charset, etc.) via normalization.
  it.each([
    "application/json; charset=utf-8",
    "application/xml; charset=utf-8",
    "text/plain; charset=iso-8859-1",
    "image/png; name=photo.png",
  ])("handles parameterized MIME type %s", (mime) => {
    // After normalization, parameters are stripped — result should match the base type.
    const base = mime.split(";")[0].trim();
    expect(isBinaryMediaMime(mime)).toBe(isBinaryMediaMime(base));
  });

  // Handles case variations via normalization.
  it("normalizes mixed-case MIME types", () => {
    expect(isBinaryMediaMime("Application/JSON")).toBe(false);
    expect(isBinaryMediaMime("IMAGE/PNG")).toBe(true);
    expect(isBinaryMediaMime("Application/VND.MS-EXCEL")).toBe(true);
  });
});
