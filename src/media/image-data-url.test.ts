import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { describe, expect, it, vi } from "vitest";
import { decodeDataUrl } from "./image-data-url.js";

describe("decodeDataUrl", () => {
  it("preserves line-wrapped base64 and normalizes MIME casing", () => {
    const result = decodeDataUrl(" DATA:IMAGE/PNG;BASE64,\r\nSGVs\r\nbG8=\n ");
    expect(result.mimeType).toBe("image/png");
    expect(result.buffer.toString()).toBe("Hello");
  });

  it("rejects whitespace inside a base64 block", () => {
    expect(() => decodeDataUrl("data:image/png;base64,SGVs bG8=")).toThrow(
      "Invalid data URL (expected base64 data: URL).",
    );
  });

  it.each([0, 1])("checks a canonical-size payload with %i extra bytes", (extraBytes) => {
    const bytes = MAX_IMAGE_BYTES + extraBytes;
    const input = `data:image/png;base64,${Buffer.alloc(bytes).toString("base64")}`;
    if (extraBytes) {
      expect(() => decodeDataUrl(input, { maxBytes: MAX_IMAGE_BYTES })).toThrow(
        "Invalid data URL: payload exceeds size limit (",
      );
    } else {
      expect(decodeDataUrl(input, { maxBytes: MAX_IMAGE_BYTES }).buffer.byteLength).toBe(bytes);
    }
  });

  it.each([
    {
      dataUrl: "data:text/plain;base64,SGVsbG8=",
      maxBytes: undefined,
      error: /Unsupported data URL type/i,
    },
    { dataUrl: `data:image/png;base64,${"A".repeat(16)}`, maxBytes: 4, error: /size limit/i },
  ])("rejects invalid data URLs before decoding: $error", ({ dataUrl, maxBytes, error }) => {
    using bufferFromSpy = vi.spyOn(Buffer, "from");

    expect(() => decodeDataUrl(dataUrl, { maxBytes })).toThrow(error);
    expect(bufferFromSpy).not.toHaveBeenCalledWith(dataUrl.split(",")[1], "base64");
  });
});
