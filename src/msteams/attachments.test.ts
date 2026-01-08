import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMSTeamsAttachmentPlaceholder,
  buildMSTeamsMediaPayload,
  downloadMSTeamsImageAttachments,
} from "./attachments.js";

const detectMimeMock = vi.fn(async () => "image/png");
const saveMediaBufferMock = vi.fn(async () => ({
  path: "/tmp/saved.png",
  contentType: "image/png",
}));

vi.mock("../media/mime.js", () => ({
  detectMime: (...args: unknown[]) => detectMimeMock(...args),
}));

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: (...args: unknown[]) => saveMediaBufferMock(...args),
}));

describe("msteams attachments", () => {
  beforeEach(() => {
    detectMimeMock.mockClear();
    saveMediaBufferMock.mockClear();
  });

  describe("buildMSTeamsAttachmentPlaceholder", () => {
    it("returns empty string when no attachments", () => {
      expect(buildMSTeamsAttachmentPlaceholder(undefined)).toBe("");
      expect(buildMSTeamsAttachmentPlaceholder([])).toBe("");
    });

    it("returns image placeholder for image attachments", () => {
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "image/png", contentUrl: "https://x/img.png" },
        ]),
      ).toBe("<media:image>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "image/png", contentUrl: "https://x/1.png" },
          { contentType: "image/jpeg", contentUrl: "https://x/2.jpg" },
        ]),
      ).toBe("<media:image> (2 images)");
    });

    it("treats Teams file.download.info image attachments as images", () => {
      expect(
        buildMSTeamsAttachmentPlaceholder([
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: { downloadUrl: "https://x/dl", fileType: "png" },
          },
        ]),
      ).toBe("<media:image>");
    });

    it("returns document placeholder for non-image attachments", () => {
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "application/pdf", contentUrl: "https://x/x.pdf" },
        ]),
      ).toBe("<media:document>");
      expect(
        buildMSTeamsAttachmentPlaceholder([
          { contentType: "application/pdf", contentUrl: "https://x/1.pdf" },
          { contentType: "application/pdf", contentUrl: "https://x/2.pdf" },
        ]),
      ).toBe("<media:document> (2 files)");
    });
  });

  describe("downloadMSTeamsImageAttachments", () => {
    it("downloads and stores image contentUrl attachments", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsImageAttachments({
        attachments: [
          { contentType: "image/png", contentUrl: "https://x/img" },
        ],
        maxBytes: 1024 * 1024,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media).toHaveLength(1);
      expect(media[0]?.path).toBe("/tmp/saved.png");
      expect(fetchMock).toHaveBeenCalledWith("https://x/img");
      expect(saveMediaBufferMock).toHaveBeenCalled();
    });

    it("supports Teams file.download.info downloadUrl attachments", async () => {
      const fetchMock = vi.fn(async () => {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsImageAttachments({
        attachments: [
          {
            contentType: "application/vnd.microsoft.teams.file.download.info",
            content: { downloadUrl: "https://x/dl", fileType: "png" },
          },
        ],
        maxBytes: 1024 * 1024,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledWith("https://x/dl");
    });

    it("retries with auth when the first request is unauthorized", async () => {
      const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
        const hasAuth = Boolean(
          opts &&
            typeof opts === "object" &&
            "headers" in opts &&
            (opts.headers as Record<string, string>)?.Authorization,
        );
        if (!hasAuth) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      });

      const media = await downloadMSTeamsImageAttachments({
        attachments: [
          { contentType: "image/png", contentUrl: "https://x/img" },
        ],
        maxBytes: 1024 * 1024,
        tokenProvider: { getAccessToken: vi.fn(async () => "token") },
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("ignores non-image attachments", async () => {
      const fetchMock = vi.fn();
      const media = await downloadMSTeamsImageAttachments({
        attachments: [
          { contentType: "application/pdf", contentUrl: "https://x/x.pdf" },
        ],
        maxBytes: 1024 * 1024,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      expect(media).toHaveLength(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("buildMSTeamsMediaPayload", () => {
    it("returns single and multi-file fields", () => {
      const payload = buildMSTeamsMediaPayload([
        { path: "/tmp/a.png", contentType: "image/png" },
        { path: "/tmp/b.png", contentType: "image/png" },
      ]);
      expect(payload.MediaPath).toBe("/tmp/a.png");
      expect(payload.MediaUrl).toBe("/tmp/a.png");
      expect(payload.MediaPaths).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaUrls).toEqual(["/tmp/a.png", "/tmp/b.png"]);
      expect(payload.MediaTypes).toEqual(["image/png", "image/png"]);
    });
  });
});
