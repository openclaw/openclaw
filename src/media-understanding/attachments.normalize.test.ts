// Attachment path normalization tests cover file URL host checks and Windows
// network path rejection.
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
  resolveAttachmentKind,
} from "./attachments.normalize.js";
import { selectAttachments } from "./attachments.select.js";

describe("normalizeAttachmentPath", () => {
  it("rejects remote-host file URLs", () => {
    expect(normalizeAttachmentPath("file://attacker/share/photo.png")).toBeUndefined();
    expect(normalizeAttachmentPath("FILE://attacker/share/photo.png")).toBeUndefined();
  });

  it("rejects Windows network paths", () => {
    withMockedPlatform("win32", () => {
      expect(normalizeAttachmentPath("\\\\attacker\\share\\photo.png")).toBeUndefined();
    });
  });
});

describe("normalizeAttachments", () => {
  it("uses staged fact paths at the attachment consumer", () => {
    expect(
      normalizeAttachments({
        media: [
          {
            path: "/tmp/staged/voice.ogg",
            url: "/tmp/staged/voice.ogg",
            contentType: "audio/ogg",
            workspaceDir: "/tmp/staged",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        path: "/tmp/staged/voice.ogg",
        url: "/tmp/staged/voice.ogg",
        workspaceDir: "/tmp/staged",
      }),
    ]);
  });

  it.each([
    {
      name: "filename-only SVG",
      fact: { fileName: "diagram.svg", contentType: "application/octet-stream" },
    },
  ])("does not select $name for image understanding", ({ fact }) => {
    const attachments = normalizeAttachments({
      media: [{ url: "https://cdn.example.test/download/opaque", ...fact }],
    });

    expect(selectAttachments({ capability: "image", attachments }).selected).toEqual([]);
  });
});

describe("resolveAttachmentKind", () => {
  it("treats stickers as images despite conflicting MIME", () => {
    expect(
      resolveAttachmentKind({
        url: "https://cdn.example.test/sticker",
        kind: "sticker",
        mime: "audio/ogg",
        index: 0,
      }),
    ).toBe("image");
  });
});
