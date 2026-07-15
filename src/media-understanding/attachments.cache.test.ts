// Attachment cache tests cover MIME detection after local and remote bytes are available.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { MediaAttachmentCache } from "./attachments.js";

const readRemoteMediaBufferMock = vi.hoisted(() => vi.fn());

vi.mock("../media/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../media/fetch.js")>("../media/fetch.js");
  return {
    ...actual,
    readRemoteMediaBuffer: readRemoteMediaBufferMock,
  };
});

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  "base64",
);

describe("media understanding attachment MIME detection", () => {
  afterEach(() => {
    readRemoteMediaBufferMock.mockReset();
  });

  it("prefers local attachment bytes over conflicting declared MIME", async () => {
    await withTempDir({ prefix: "openclaw-media-cache-mime-local-" }, async (base) => {
      const attachmentPath = path.join(base, "photo.jpg");
      await fs.writeFile(attachmentPath, PNG_1X1);
      const cache = new MediaAttachmentCache(
        [{ index: 0, path: attachmentPath, mime: "application/pdf" }],
        { localPathRoots: [base] },
      );

      const result = await cache.getBuffer({
        attachmentIndex: 0,
        maxBytes: 1024,
        timeoutMs: 1000,
      });

      expect(result.mime).toBe("image/png");
    });
  });

  it("prefers remote attachment bytes over conflicting MIME metadata", async () => {
    const url = "https://example.com/photo.jpg";
    readRemoteMediaBufferMock.mockResolvedValue({
      buffer: PNG_1X1,
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });
    const cache = new MediaAttachmentCache([{ index: 0, url, mime: "application/pdf" }]);

    const result = await cache.getBuffer({
      attachmentIndex: 0,
      maxBytes: 1024,
      timeoutMs: 1000,
    });

    expect(result.mime).toBe("image/png");
  });
});
