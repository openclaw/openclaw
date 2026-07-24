import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalMediaPath } from "./local-media-path.js";

describe("resolveLocalMediaPath", () => {
  it("resolves relative paths so local reads stay guarded", () => {
    expect(resolveLocalMediaPath("photos/cat.png")).toBe(path.resolve("photos/cat.png"));
    expect(resolveLocalMediaPath("../escape.png")).toBe(path.resolve("../escape.png"));
    expect(resolveLocalMediaPath("./cat.png")).toBe(path.resolve("cat.png"));
  });

  it("resolves absolute paths", () => {
    const absolute = path.resolve(path.sep, "tmp", "media", "cat.png");
    expect(resolveLocalMediaPath(absolute)).toBe(absolute);
  });

  it("returns undefined for remote, data, and scheme-prefixed sources", () => {
    expect(resolveLocalMediaPath("https://example.com/cat.png")).toBeUndefined();
    expect(resolveLocalMediaPath("mxc://matrix.org/abc")).toBeUndefined();
    expect(resolveLocalMediaPath("buffer://message-send/attachment")).toBeUndefined();
    expect(resolveLocalMediaPath("data:image/png;base64,AAAA")).toBeUndefined();
    expect(resolveLocalMediaPath("media://abc123")).toBeUndefined();
    expect(resolveLocalMediaPath("")).toBeUndefined();
    expect(resolveLocalMediaPath("   ")).toBeUndefined();
  });
});
