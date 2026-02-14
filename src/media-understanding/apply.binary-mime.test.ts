import { describe, expect, it } from "vitest";
import { isBinaryMediaMime } from "./apply.js";

describe("isBinaryMediaMime", () => {
  it.each([
    "image/png",
    "image/jpeg",
    "audio/mpeg",
    "video/mp4",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/octet-stream",
    "application/pdf",
    "application/gzip",
  ])("returns true for %s", (mime) => {
    expect(isBinaryMediaMime(mime)).toBe(true);
  });

  it.each(["text/plain", "text/html", "text/csv", "application/json", "application/xml"])(
    "returns false for %s",
    (mime) => {
      expect(isBinaryMediaMime(mime)).toBe(false);
    },
  );

  it("returns false for undefined", () => {
    expect(isBinaryMediaMime(undefined)).toBe(false);
  });
});
