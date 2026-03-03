import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../media/fetch.js", () => ({
  fetchRemoteMedia: vi.fn(),
  MediaFetchError: class MediaFetchError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { fetchRemoteMedia } from "../media/fetch.js";
import { MediaAttachmentCache } from "./attachments.js";

const mockedFetchRemoteMedia = vi.mocked(fetchRemoteMedia);

describe("MediaAttachmentCache Discord SSRF policy", () => {
  beforeEach(() => {
    mockedFetchRemoteMedia.mockReset();
    mockedFetchRemoteMedia.mockResolvedValue({
      buffer: Buffer.from("ok"),
      contentType: "image/png",
      fileName: "a.png",
    });
  });

  it("passes Discord CDN SSRF policy for discord attachment URLs", async () => {
    const cache = new MediaAttachmentCache([
      { index: 0, url: "https://cdn.discordapp.com/attachments/1/a.png" },
    ]);

    await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

    expect(mockedFetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mockedFetchRemoteMedia.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        url: "https://cdn.discordapp.com/attachments/1/a.png",
        ssrfPolicy: {
          allowedHostnames: ["cdn.discordapp.com", "media.discordapp.net"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
  });

  it("does not apply Discord-specific SSRF policy to non-Discord URLs", async () => {
    const cache = new MediaAttachmentCache([{ index: 0, url: "https://example.com/a.png" }]);

    await cache.getBuffer({ attachmentIndex: 0, maxBytes: 1024, timeoutMs: 1000 });

    expect(mockedFetchRemoteMedia).toHaveBeenCalledTimes(1);
    expect(mockedFetchRemoteMedia.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        url: "https://example.com/a.png",
        ssrfPolicy: undefined,
      }),
    );
  });
});
