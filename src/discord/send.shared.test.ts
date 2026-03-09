import { describe, expect, it } from "vitest";
import { toDiscordFileBlob } from "./send.shared.js";

describe("toDiscordFileBlob", () => {
  it("sets content type on Blob created from Uint8Array", () => {
    const data = new Uint8Array([1, 2, 3]);
    const blob = toDiscordFileBlob(data, "image/webp");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/webp");
    expect(blob.size).toBe(3);
  });

  it("leaves type empty when no contentType provided", () => {
    const data = new Uint8Array([1, 2, 3]);
    const blob = toDiscordFileBlob(data);
    expect(blob.type).toBe("");
  });

  it("returns existing Blob unchanged when it already has a type", () => {
    const original = new Blob([new Uint8Array([1])], { type: "image/png" });
    const result = toDiscordFileBlob(original, "image/webp");
    expect(result).toBe(original);
    expect(result.type).toBe("image/png");
  });

  it("re-wraps Blob with contentType when Blob has no type", () => {
    const original = new Blob([new Uint8Array([1, 2])]);
    expect(original.type).toBe("");
    const result = toDiscordFileBlob(original, "image/gif");
    expect(result).not.toBe(original);
    expect(result.type).toBe("image/gif");
    expect(result.size).toBe(2);
  });

  it("returns typeless Blob as-is when no contentType provided", () => {
    const original = new Blob([new Uint8Array([1])]);
    const result = toDiscordFileBlob(original);
    expect(result).toBe(original);
    expect(result.type).toBe("");
  });
});
