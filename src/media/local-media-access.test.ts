import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalMediaAllowed } from "./local-media-access.js";

describe("assertLocalMediaAllowed", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts unresolved tmp paths when the allowed root resolves through a symlink", async () => {
    const mediaPath = "/tmp/openclaw/video.mp4";
    const rootPath = "/tmp/openclaw";

    vi.spyOn(fs, "realpath").mockImplementation(async (targetPath: string) => {
      if (targetPath === mediaPath) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      if (targetPath === rootPath) {
        return "/private/tmp/openclaw";
      }
      return targetPath;
    });

    await expect(assertLocalMediaAllowed(mediaPath, [rootPath])).resolves.toBeUndefined();
  });

  it("accepts realpath-normalized tmp paths when the configured root keeps the original form", async () => {
    const mediaPath = "/tmp/openclaw/video.mp4";
    const rootPath = "/tmp/openclaw";

    vi.spyOn(fs, "realpath").mockImplementation(async (targetPath: string) => {
      if (targetPath === mediaPath) {
        return "/private/tmp/openclaw/video.mp4";
      }
      if (targetPath === rootPath) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return targetPath;
    });

    await expect(assertLocalMediaAllowed(mediaPath, [rootPath])).resolves.toBeUndefined();
  });

  it("still rejects sibling paths outside the allowed symlinked root", async () => {
    const mediaPath = "/tmp/openclaw-other/video.mp4";
    const rootPath = "/tmp/openclaw";

    vi.spyOn(fs, "realpath").mockImplementation(async (targetPath: string) => {
      if (targetPath === mediaPath) {
        return "/private/tmp/openclaw-other/video.mp4";
      }
      if (targetPath === rootPath) {
        return "/private/tmp/openclaw";
      }
      return targetPath;
    });

    await expect(assertLocalMediaAllowed(mediaPath, [rootPath])).rejects.toMatchObject({
      code: "path-not-allowed",
    });
  });
});
