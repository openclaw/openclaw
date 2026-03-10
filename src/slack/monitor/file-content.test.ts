import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFetchError } from "../../media/fetch.js";
import * as mediaFetch from "../../media/fetch.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import { resolveSlackFileContent } from "./file-content.js";

describe("resolveSlackFileContent", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts markdown/text/json/csv content into snippets", async () => {
    const fetchRemoteMediaMock = vi.spyOn(mediaFetch, "fetchRemoteMedia");
    fetchRemoteMediaMock
      .mockResolvedValueOnce({
        buffer: Buffer.from("# Heading\nBody"),
        contentType: "text/markdown",
        fileName: "a.md",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('{"a":1,"b":2}'),
        contentType: "application/json",
        fileName: "b.json",
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from("x,y\n1,2"),
        contentType: "text/csv",
        fileName: "c.csv",
      });

    const result = await resolveSlackFileContent({
      files: [
        { name: "a.md", url_private: "https://files.slack.com/a.md" },
        { name: "b.json", url_private: "https://files.slack.com/b.json" },
        { name: "c.csv", url_private: "https://files.slack.com/c.csv" },
      ],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.issues).toEqual([]);
    expect(result.snippets).toHaveLength(3);
    expect(result.snippets[0]?.fileName).toBe("a.md");
    expect(result.snippets[0]?.text).toContain("Heading");
    expect(result.snippets[1]?.text).toContain('"a": 1');
    expect(result.snippets[2]?.text).toContain("x,y");
  });

  it("extracts PDF text when available", async () => {
    vi.spyOn(mediaFetch, "fetchRemoteMedia").mockResolvedValueOnce({
      buffer: Buffer.from("%PDF"),
      contentType: "application/pdf",
      fileName: "doc.pdf",
    });
    vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValueOnce({
      text: "PDF body text",
      images: [],
    });

    const result = await resolveSlackFileContent({
      files: [{ name: "doc.pdf", url_private: "https://files.slack.com/doc.pdf" }],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.issues).toEqual([]);
    expect(result.snippets).toHaveLength(1);
    expect(result.snippets[0]?.text).toContain("PDF body text");
  });

  it("reports permission errors for missing scope/auth", async () => {
    vi.spyOn(mediaFetch, "fetchRemoteMedia").mockRejectedValueOnce(
      new Error("An API error occurred: missing_scope"),
    );

    const result = await resolveSlackFileContent({
      files: [{ name: "secret.md", url_private: "https://files.slack.com/secret.md" }],
      token: "xoxb-test",
      maxBytes: 1024 * 1024,
    });

    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([
      {
        fileName: "secret.md",
        reason: "permission",
      },
    ]);
  });

  it("reports size and unsupported format failures", async () => {
    const fetchRemoteMediaMock = vi.spyOn(mediaFetch, "fetchRemoteMedia");
    fetchRemoteMediaMock
      .mockRejectedValueOnce(new MediaFetchError("max_bytes", "too large"))
      .mockResolvedValueOnce({
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
        contentType: "image/jpeg",
        fileName: "photo.jpg",
      });

    const result = await resolveSlackFileContent({
      files: [
        { name: "too-big.txt", url_private: "https://files.slack.com/too-big.txt" },
        { name: "photo.jpg", url_private: "https://files.slack.com/photo.jpg" },
      ],
      token: "xoxb-test",
      maxBytes: 1024,
    });

    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([
      {
        fileName: "too-big.txt",
        reason: "size_exceeded",
      },
      {
        fileName: "photo.jpg",
        reason: "unsupported_format",
      },
    ]);
  });
});
