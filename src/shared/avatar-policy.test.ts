// Avatar policy tests cover avatar source resolution and fallback behavior.
import { describe, expect, it } from "vitest";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isSupportedLocalAvatarExtension,
  isWindowsAbsolutePath,
  looksLikeAvatarPath,
  resolveAvatarMime,
} from "./avatar-policy.js";

describe("avatar policy", () => {
  it("classifies avatar URI and path helpers directly", () => {
    expect(isAvatarDataUrl("data:text/plain,hello")).toBe(true);
    expect(isAvatarHttpUrl("https://example.com/avatar.png")).toBe(true);
    expect(isAvatarHttpUrl("ftp://example.com/avatar.png")).toBe(false);
    expect(hasAvatarUriScheme("slack://avatar")).toBe(true);
    expect(isWindowsAbsolutePath("C:\\\\avatars\\\\openclaw.png")).toBe(true);
  });

  it("detects avatar-like path strings", () => {
    expect(looksLikeAvatarPath("avatars/openclaw.svg")).toBe(true);
    expect(looksLikeAvatarPath("openclaw.webp")).toBe(true);
    expect(looksLikeAvatarPath("avatar.ico")).toBe(true);
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
    expect(resolveAvatarMime("A.PNG")).toBe("image/png");
    expect(resolveAvatarMime("a.bin")).toBe("application/octet-stream");
  });
});
