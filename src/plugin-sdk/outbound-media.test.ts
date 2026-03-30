import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMediaMock = vi.hoisted(() => vi.fn());

vi.mock("./web-media.js", () => ({
  loadWebMedia: loadWebMediaMock,
}));

type OutboundMediaModule = typeof import("./outbound-media.js");

let loadOutboundMediaFromUrl: OutboundMediaModule["loadOutboundMediaFromUrl"];

describe("loadOutboundMediaFromUrl", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ loadOutboundMediaFromUrl } = await import("./outbound-media.js"));
    loadWebMediaMock.mockReset();
  });

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
