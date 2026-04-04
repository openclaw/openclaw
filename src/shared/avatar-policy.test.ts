import { describe, expect, it } from "vitest";
import {
  resolveAvatarMime,
  isAvatarDataUrl,
  isAvatarImageDataUrl,
  isAvatarHttpUrl,
  isWindowsAbsolutePath,
  isWorkspaceRelativeAvatarPath,
  isPathWithinRoot,
  looksLikeAvatarPath,
  isSupportedLocalAvatarExtension,
} from "./avatar-policy.js";

describe("resolveAvatarMime", () => {
  it("resolves common image extensions", () => {
    expect(resolveAvatarMime("avatar.png")).toBe("image/png");
    expect(resolveAvatarMime("avatar.jpg")).toBe("image/jpeg");
    expect(resolveAvatarMime("avatar.jpeg")).toBe("image/jpeg");
    expect(resolveAvatarMime("avatar.webp")).toBe("image/webp");
    expect(resolveAvatarMime("avatar.gif")).toBe("image/gif");
    expect(resolveAvatarMime("avatar.svg")).toBe("image/svg+xml");
  });

  it("returns octet-stream for unknown extensions", () => {
    expect(resolveAvatarMime("avatar.unknown")).toBe("application/octet-stream");
  });

  it("handles case-insensitive extensions", () => {
    expect(resolveAvatarMime("avatar.PNG")).toBe("image/png");
    expect(resolveAvatarMime("avatar.JPEG")).toBe("image/jpeg");
  });
});

describe("isAvatarDataUrl", () => {
  it("detects data URLs", () => {
    expect(isAvatarDataUrl("data:image/png;base64,abc")).toBe(true);
    expect(isAvatarDataUrl("DATA:text/plain,hello")).toBe(true);
  });

  it("returns false for non-data URLs", () => {
    expect(isAvatarDataUrl("https://example.com/avatar.png")).toBe(false);
    expect(isAvatarDataUrl("/path/to/file")).toBe(false);
  });
});

describe("isAvatarImageDataUrl", () => {
  it("detects image data URLs", () => {
    expect(isAvatarImageDataUrl("data:image/png;base64,abc")).toBe(true);
    expect(isAvatarImageDataUrl("data:image/jpeg;base64,xyz")).toBe(true);
  });

  it("rejects non-image data URLs", () => {
    expect(isAvatarImageDataUrl("data:text/plain,hello")).toBe(false);
  });
});

describe("isAvatarHttpUrl", () => {
  it("detects HTTP URLs", () => {
    expect(isAvatarHttpUrl("http://example.com/avatar.png")).toBe(true);
    expect(isAvatarHttpUrl("https://example.com/avatar.png")).toBe(true);
  });

  it("rejects non-HTTP URLs", () => {
    expect(isAvatarHttpUrl("ftp://example.com/avatar.png")).toBe(false);
    expect(isAvatarHttpUrl("data:image/png;base64,abc")).toBe(false);
  });
});

describe("isWindowsAbsolutePath", () => {
  it("detects Windows absolute paths", () => {
    expect(isWindowsAbsolutePath("C:\\Users\\test")).toBe(true);
    expect(isWindowsAbsolutePath("D:\\folder\\file.png")).toBe(true);
  });

  it("rejects Unix paths", () => {
    expect(isWindowsAbsolutePath("/home/user/avatar.png")).toBe(false);
  });
});

describe("isWorkspaceRelativeAvatarPath", () => {
  it("returns true for relative paths", () => {
    expect(isWorkspaceRelativeAvatarPath("avatar.png")).toBe(true);
    expect(isWorkspaceRelativeAvatarPath("folder/avatar.png")).toBe(true);
  });

  it("returns false for absolute paths", () => {
    expect(isWorkspaceRelativeAvatarPath("/home/user/avatar.png")).toBe(false);
    expect(isWorkspaceRelativeAvatarPath("C:\\Users\\avatar.png")).toBe(false);
  });

  it("returns false for home directory paths", () => {
    expect(isWorkspaceRelativeAvatarPath("~/avatar.png")).toBe(false);
  });
});

describe("isPathWithinRoot", () => {
  it("returns true for paths within root", () => {
    expect(isPathWithinRoot("/home/user", "/home/user/avatar.png")).toBe(true);
    expect(isPathWithinRoot("/home/user", "/home/user/folder/avatar.png")).toBe(true);
  });

  it("returns true for exact match", () => {
    expect(isPathWithinRoot("/home/user", "/home/user")).toBe(true);
  });

  it("returns false for paths outside root", () => {
    expect(isPathWithinRoot("/home/user", "/home/other/avatar.png")).toBe(false);
  });
});

describe("looksLikeAvatarPath", () => {
  it("detects avatar-like paths", () => {
    expect(looksLikeAvatarPath("avatar.png")).toBe(true);
    expect(looksLikeAvatarPath("folder/avatar.jpg")).toBe(true);
    expect(looksLikeAvatarPath("C:\\Users\\avatar.gif")).toBe(true);
  });

  it("detects by extension", () => {
    expect(looksLikeAvatarPath("somefile.png")).toBe(true);
    expect(looksLikeAvatarPath("doc.pdf")).toBe(false);
  });
});

describe("isSupportedLocalAvatarExtension", () => {
  it("returns true for supported extensions", () => {
    expect(isSupportedLocalAvatarExtension("avatar.png")).toBe(true);
    expect(isSupportedLocalAvatarExtension("avatar.jpg")).toBe(true);
    expect(isSupportedLocalAvatarExtension("avatar.gif")).toBe(true);
    expect(isSupportedLocalAvatarExtension("avatar.webp")).toBe(true);
    expect(isSupportedLocalAvatarExtension("avatar.svg")).toBe(true);
  });

  it("returns false for unsupported extensions", () => {
    expect(isSupportedLocalAvatarExtension("document.pdf")).toBe(false);
    expect(isSupportedLocalAvatarExtension("video.mp4")).toBe(false);
  });
});
