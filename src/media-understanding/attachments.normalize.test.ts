// Attachment path normalization tests cover file URL host checks and Windows
// network path rejection.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  normalizeAttachmentPath,
  normalizeAttachments,
  resolveAttachmentKind,
} from "./attachments.normalize.js";
import { selectAttachments } from "./attachments.select.js";

describe("normalizeAttachmentPath", () => {
  it("allows localhost file URLs", () => {
    const localPath = path.join(os.tmpdir(), "photo.png");
    const fileUrl = pathToFileURL(localPath);
    fileUrl.hostname = "localhost";

    expect(normalizeAttachmentPath(fileUrl.href)).toBe(localPath);
  });

  it("recognizes file URL schemes case-insensitively", () => {
    const localPath = path.join(os.tmpdir(), "photo with space.png");
    const fileUrl = pathToFileURL(localPath).href.replace(/^file:/u, "FILE:");

    expect(normalizeAttachmentPath(fileUrl)).toBe(localPath);
  });

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
  it("preserves original fact indexes when empty slots are not materializable", () => {
    expect(
      normalizeAttachments({
        media: [
          {},
          { path: "/tmp/voice.ogg", contentType: "audio/ogg" },
          { url: "https://example.test/photo.jpg", contentType: "image/jpeg" },
        ],
      }).map((attachment) => attachment.index),
    ).toEqual([1, 2]);
  });

  it("normalizes ordered facts", () => {
    expect(
      normalizeAttachments({
        media: [
          { path: " /tmp/voice.ogg ", contentType: " audio/ogg ", transcribed: true },
          { url: "https://example.test/photo.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      {
        path: "/tmp/voice.ogg",
        url: undefined,
        mime: "audio/ogg",
        kind: "audio",
        index: 0,
        alreadyTranscribed: true,
      },
      {
        path: undefined,
        url: "https://example.test/photo.jpg",
        mime: undefined,
        kind: "image",
        index: 1,
        alreadyTranscribed: false,
      },
    ]);
  });

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

  it("distinguishes an explicit document from generic binary MIME inference", () => {
    const attachments = normalizeAttachments({
      media: [
        { path: "/tmp/upload.avif", contentType: "application/octet-stream" },
        {
          path: "/tmp/report.png",
          contentType: "application/octet-stream",
          kind: "document",
        },
      ],
    });

    expect(attachments.map(({ kind }) => kind)).toEqual([undefined, "document"]);
    expect(attachments.map(resolveAttachmentKind)).toEqual(["image", "unknown"]);
  });

  it("omits optional attachment fields when canonical facts do not declare them", () => {
    const [attachment] = normalizeAttachments({
      media: [{ path: "/tmp/photo.png", contentType: "application/octet-stream" }],
    });

    expect(attachment).toEqual({
      path: "/tmp/photo.png",
      url: undefined,
      mime: "application/octet-stream",
      index: 0,
      alreadyTranscribed: false,
    });
  });

  it.each([
    { fileName: "photo.png", capability: "image", contentType: "application/octet-stream" },
    { fileName: "voice.ogg", capability: "audio", contentType: undefined },
    { fileName: "clip.mp4", capability: "video", contentType: "application/octet-stream" },
    { fileName: "scan.TIFF", capability: "image", contentType: "binary/octet-stream" },
  ] as const)(
    "selects opaque-source $fileName for its $capability provider",
    ({ fileName, capability, contentType }) => {
      const attachments = normalizeAttachments({
        media: [
          {
            url: "https://cdn.example.test/download/opaque",
            fileName,
            contentType,
          },
        ],
      });

      expect(attachments.map(resolveAttachmentKind)).toEqual([capability]);
      expect(selectAttachments({ capability, attachments }).selected).toEqual(attachments);
    },
  );

  it.each([
    {
      name: "filename-only SVG",
      fact: { fileName: "diagram.svg", contentType: "application/octet-stream" },
    },
    {
      name: "SVG source before a raster display filename",
      fact: { path: "/tmp/diagram.svg", fileName: "photo.png" },
    },
    {
      name: "authoritative document kind",
      fact: { fileName: "photo.png", kind: "document" as const },
    },
    {
      name: "authoritative document MIME",
      fact: { fileName: "photo.png", contentType: "application/pdf" },
    },
  ])("does not select $name for image understanding", ({ fact }) => {
    const attachments = normalizeAttachments({
      media: [{ url: "https://cdn.example.test/download/opaque", ...fact }],
    });

    expect(selectAttachments({ capability: "image", attachments }).selected).toEqual([]);
  });

  it.each([
    ["audio", "ogg", undefined],
    ["audio", "ogg", "photo.png"],
    ["video", "mp4", undefined],
    ["video", "mp4", "photo.png"],
  ] as const)(
    "selects the %s .%s URL with display filename %s",
    (capability, extension, fileName) => {
      const attachments = normalizeAttachments({
        media: [
          {
            path: "/tmp/opaque",
            url: `https://cdn.example.test/download/media.${extension}`,
            fileName,
            contentType: "application/octet-stream",
          },
        ],
      });

      expect(selectAttachments({ capability, attachments }).selected).toEqual(attachments);
      expect(selectAttachments({ capability: "image", attachments }).selected).toEqual([]);
    },
  );
});

describe("resolveAttachmentKind", () => {
  it.each([
    { source: "/tmp/scan.TIFF", expected: "image" },
    { source: " /tmp/photo.png ", expected: "image" },
    { source: " /tmp/scan.TIFF ", expected: "image" },
    { source: "https://cdn.example.test/photo%2EHEIC?download=1", expected: "image" },
  ] as const)(
    "classifies $source as $expected from canonical media metadata",
    ({ source, expected }) => {
      expect(resolveAttachmentKind({ path: source, index: 0 })).toBe(expected);
    },
  );

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

  it("does not let the unknown category mask a concrete audio MIME", () => {
    expect(
      resolveAttachmentKind({
        url: "https://cdn.example.test/download",
        kind: "unknown",
        mime: "audio/ogg",
        index: 0,
      }),
    ).toBe("audio");
  });

  it("keeps explicit documents authoritative over image MIME and filename", () => {
    expect(
      resolveAttachmentKind({
        path: "/tmp/report.png",
        kind: "document",
        mime: "image/png",
        index: 0,
      }),
    ).toBe("unknown");
  });

  it("infers an unknown-kind image from its filename despite generic MIME", () => {
    expect(
      resolveAttachmentKind({
        path: "/tmp/upload.png",
        kind: "unknown",
        mime: "application/octet-stream",
        index: 0,
      }),
    ).toBe("image");
  });

  it("never infers an image over authoritative document MIME", () => {
    expect(
      resolveAttachmentKind({
        path: "/tmp/report.png",
        kind: "unknown",
        mime: "application/pdf",
        index: 0,
      }),
    ).toBe("unknown");
    expect(
      resolveAttachmentKind({ path: "/tmp/report.png", mime: "application/pdf", index: 0 }),
    ).toBe("unknown");
  });

  it("prefers the authoritative kind over conflicting MIME and filename hints", () => {
    expect(
      resolveAttachmentKind({
        path: "/tmp/video.mp4",
        mime: "video/mp4",
        kind: "image",
        index: 0,
      }),
    ).toBe("image");
  });

  it("preserves explicit MIME precedence over a conflicting filename", () => {
    expect(resolveAttachmentKind({ path: "/tmp/video.mp4", mime: "image/heic", index: 0 })).toBe(
      "image",
    );
  });

  it("preserves explicitly identified SVG images", () => {
    expect(
      resolveAttachmentKind({ path: "/tmp/diagram.svg", mime: "image/svg+xml", index: 0 }),
    ).toBe("image");
  });
});
