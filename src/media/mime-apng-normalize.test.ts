import { describe, expect, it, vi } from "vitest";

vi.mock("file-type", () => ({
  fileTypeFromBuffer: vi.fn().mockResolvedValue({
    mime: "image/apng",
    ext: "apng",
  }),
}));

describe("mime buffer sniff apng normalization", () => {
  it("maps image/apng from file-type to image/png", async () => {
    const { detectMime } = await import("./mime.js");
    const mime = await detectMime({ buffer: Buffer.from("any") });
    expect(mime).toBe("image/png");
  });
});
