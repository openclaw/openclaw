// Tests music provider asset normalization and base64 size bounds enforcement.
import { describe, expect, it } from "vitest";
import { generatedMusicAssetFromBase64 } from "./provider-assets.js";

describe("generatedMusicAssetFromBase64", () => {
  it("converts a valid base64 payload into a music asset", () => {
    const audioBytes = Buffer.from("mp3-bytes");
    const asset = generatedMusicAssetFromBase64({
      base64: audioBytes.toString("base64"),
      mimeType: "audio/mpeg",
      index: 0,
    });
    if (!asset) {
      throw new Error("Expected generated music asset");
    }
    expect(asset.buffer).toEqual(audioBytes);
    expect(asset.mimeType).toBe("audio/mpeg");
    expect(asset.fileName).toBe("track-1.mp3");
  });

  it("rejects oversized base64 payload before decoding", () => {
    const oversizedBase64 = "A".repeat(200);
    expect(
      generatedMusicAssetFromBase64({
        base64: oversizedBase64,
        mimeType: "audio/mpeg",
        maxBytes: 10,
      }),
    ).toBeUndefined();
  });

  it("uses custom fileName when provided", () => {
    const asset = generatedMusicAssetFromBase64({
      base64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mpeg",
      fileName: "custom.mp3",
      index: 5,
    });
    if (!asset) {
      throw new Error("Expected generated music asset");
    }
    expect(asset.fileName).toBe("custom.mp3");
  });
});
