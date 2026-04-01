import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { normalizeAttachmentPath } from "./attachments.normalize.js";

describe("normalizeAttachmentPath", () => {
  it("allows localhost file URLs", () => {
    const localPath = path.join(os.tmpdir(), "photo.png");
    const fileUrl = pathToFileURL(localPath);
    fileUrl.hostname = "localhost";

    expect(normalizeAttachmentPath(fileUrl.href)).toBe(localPath);
  });

  it("rejects remote-host file URLs", () => {
    expect(normalizeAttachmentPath("file://attacker/share/photo.png")).toBeUndefined();
  });

  it("rejects Windows network paths", () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      expect(normalizeAttachmentPath("\\\\attacker\\share\\photo.png")).toBeUndefined();
    } finally {
      platformSpy.mockRestore();
    }
  });
});
