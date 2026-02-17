import { describe, expect, it } from "vitest";
import { maxBytesForKind, mediaKindFromMime } from "./constants.js";

describe("mediaKindFromMime", () => {
  it("classifies image types", () => {
    expect(mediaKindFromMime("image/png")).toBe("image");
    expect(mediaKindFromMime("image/jpeg")).toBe("image");
  });

  it("classifies audio types", () => {
    expect(mediaKindFromMime("audio/mpeg")).toBe("audio");
    expect(mediaKindFromMime("audio/ogg")).toBe("audio");
  });

  it("classifies video types", () => {
    expect(mediaKindFromMime("video/mp4")).toBe("video");
  });

  it("classifies document types", () => {
    expect(mediaKindFromMime("application/pdf")).toBe("document");
    expect(mediaKindFromMime("text/plain")).toBe("document");
    expect(mediaKindFromMime("application/json")).toBe("document");
  });

  it("returns unknown for null/undefined/empty", () => {
    expect(mediaKindFromMime(null)).toBe("unknown");
    expect(mediaKindFromMime(undefined)).toBe("unknown");
    expect(mediaKindFromMime("")).toBe("unknown");
  });

  it("returns unknown for unrecognized mime", () => {
    expect(mediaKindFromMime("font/woff2")).toBe("unknown");
  });
});

describe("maxBytesForKind", () => {
  it("returns correct limits for each kind", () => {
    expect(maxBytesForKind("image")).toBe(6 * 1024 * 1024);
    expect(maxBytesForKind("audio")).toBe(16 * 1024 * 1024);
    expect(maxBytesForKind("video")).toBe(16 * 1024 * 1024);
    expect(maxBytesForKind("document")).toBe(100 * 1024 * 1024);
    expect(maxBytesForKind("unknown")).toBe(100 * 1024 * 1024);
  });
});
