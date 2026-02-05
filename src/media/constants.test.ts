import { describe, expect, it } from "vitest";
import { mediaKindFromMime } from "./constants.js";

describe("mediaKindFromMime", () => {
  it("returns known kinds for standard MIME types", () => {
    expect(mediaKindFromMime("image/png")).toBe("image");
    expect(mediaKindFromMime("audio/mpeg")).toBe("audio");
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("application/pdf")).toBe("document");
    expect(mediaKindFromMime("application/zip")).toBe("document");
  });

  it('returns "unknown" for undefined/null/empty MIME', () => {
    expect(mediaKindFromMime(undefined)).toBe("unknown");
    expect(mediaKindFromMime(null)).toBe("unknown");
    expect(mediaKindFromMime("")).toBe("unknown");
  });

  it('returns "unknown" for unrecognized MIME types', () => {
    expect(mediaKindFromMime("text/plain")).toBe("unknown");
    expect(mediaKindFromMime("model/gltf-binary")).toBe("unknown");
  });

  it('"unknown" should not be used as a truthy media placeholder', () => {
    // This is the core assertion for issue #9706:
    // "unknown" is truthy in JS, so callers must explicitly exclude it
    const kind = mediaKindFromMime(undefined);
    expect(kind).toBe("unknown");
    expect(kind && kind !== "unknown").toBeFalsy();
  });
});
