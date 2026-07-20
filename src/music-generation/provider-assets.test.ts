// Tests music provider asset normalization.
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
    expect(asset.buffer).toEqual(audioBytes);
    expect(asset.mimeType).toBe("audio/mpeg");
    expect(asset.fileName).toBe("track-1.mp3");
  });

  it("uses custom fileName when provided", () => {
    const asset = generatedMusicAssetFromBase64({
      base64: Buffer.from("x").toString("base64"),
      mimeType: "audio/mpeg",
      fileName: "custom.mp3",
      index: 5,
    });
    expect(asset.fileName).toBe("custom.mp3");
  });
});
