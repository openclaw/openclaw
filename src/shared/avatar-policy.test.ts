import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPathWithinRoot,
  isSupportedLocalAvatarExtension,
  isWorkspaceRelativeAvatarPath,
  looksLikeAvatarPath,
  resolveAvatarMime,
} from "./avatar-policy.js";

describe("avatar policy", () => {
  it("accepts workspace-relative avatar paths and rejects URI schemes", () => {
    expect(isWorkspaceRelativeAvatarPath("avatars/bot.png")).toBe(true);
    expect(isWorkspaceRelativeAvatarPath("C:\\\\avatars\\\\bot.png")).toBe(true);
    expect(isWorkspaceRelativeAvatarPath("https://example.com/avatar.png")).toBe(false);
    expect(isWorkspaceRelativeAvatarPath("data:image/png;base64,AAAA")).toBe(false);
    expect(isWorkspaceRelativeAvatarPath("~/avatar.png")).toBe(false);
  });

  it("checks path containment safely", () => {
    const root = path.resolve("/tmp/root");
    expect(isPathWithinRoot(root, path.resolve("/tmp/root/avatars/a.png"))).toBe(true);
    expect(isPathWithinRoot(root, path.resolve("/tmp/root/../outside.png"))).toBe(false);
  });

  it("detects avatar-like path strings", () => {
    expect(looksLikeAvatarPath("avatars/bot.svg")).toBe(true);
    expect(looksLikeAvatarPath("bot.webp")).toBe(true);
    expect(looksLikeAvatarPath("A")).toBe(false);
  });

  it("supports expected local file extensions", () => {
    expect(isSupportedLocalAvatarExtension("avatar.png")).toBe(true);
    expect(isSupportedLocalAvatarExtension("avatar.svg")).toBe(true);
    expect(isSupportedLocalAvatarExtension("avatar.ico")).toBe(false);
  });

  it("resolves mime type from extension", () => {
    expect(resolveAvatarMime("a.svg")).toBe("image/svg+xml");
    expect(resolveAvatarMime("a.tiff")).toBe("image/tiff");
    expect(resolveAvatarMime("a.bin")).toBe("application/octet-stream");
  });
});
