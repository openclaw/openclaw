import { describe, expect, it, vi } from "vitest";
import { loadOutboundMediaFromUrl } from "./outbound-media.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

vi.mock("../web/media.js", () => ({
  loadWebMedia: loadWebMediaMock,
}));

describe("loadOutboundMediaFromUrl", () => {
  it("forwards maxBytes and mediaLocalRoots to loadWebMedia", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await loadOutboundMediaFromUrl("file:///tmp/image.png", {
      maxBytes: 1024,
      mediaLocalRoots: ["/tmp/workspace-agent"],
    });

    expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/image.png", {
      maxBytes: 1024,
      localRoots: ["/tmp/workspace-agent"],
    });
  });

  it("keeps options optional", async () => {
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("x"),
      kind: "image",
      contentType: "image/png",
    });

    await loadOutboundMediaFromUrl("https://example.com/image.png");

    expect(loadWebMediaMock).toHaveBeenCalledWith("https://example.com/image.png", {
      maxBytes: undefined,
      localRoots: undefined,
    });
  });
});
