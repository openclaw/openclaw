/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { processProfileAvatar, ProfileAvatarError } from "./avatar-processing.ts";

function stubAvatarImage(width: number, height: number, bytes: Uint8Array<ArrayBuffer>) {
  class StubImage {
    decoding = "auto";
    src = "";
    naturalWidth = width;
    naturalHeight = height;
    decode = vi.fn(async () => undefined);
  }
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn(() => "blob:avatar");
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  vi.stubGlobal("Image", StubImage);
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    callback(new Blob([bytes], { type: type ?? "image/png" }));
  });
  return { StubImage, drawImage, revokeObjectURL };
}

describe("profile avatar processing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects unreasonable source files before browser image decoding", async () => {
    await expect(
      processProfileAvatar(
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "avatar.png", {
          type: "image/png",
        }),
      ),
    ).rejects.toMatchObject({ code: "source-too-large" } satisfies Partial<ProfileAvatarError>);
  });

  it("enforces the encoded avatar hard cap through the upload surface", async () => {
    stubAvatarImage(256, 256, new Uint8Array(512 * 1024 + 1));

    await expect(
      processProfileAvatar(new File(["source"], "avatar.png", { type: "image/png" })),
    ).rejects.toMatchObject({ code: "too-large" } satisfies Partial<ProfileAvatarError>);
  });

  it("center-crops without upscaling smaller uploads through the upload surface", async () => {
    const { StubImage, drawImage } = stubAvatarImage(80, 60, new Uint8Array([1]));

    await processProfileAvatar(new File(["source"], "avatar.png", { type: "image/png" }));

    expect(drawImage).toHaveBeenCalledWith(expect.any(StubImage), 10, 0, 60, 60, 0, 0, 60, 60);
  });

  it("decodes, downsizes, and encodes an uploaded image before the RPC payload", async () => {
    const { StubImage, drawImage, revokeObjectURL } = stubAvatarImage(
      1024,
      512,
      new Uint8Array([1, 2, 3]),
    );

    const result = await processProfileAvatar(
      new File(["source"], "avatar.jpg", { type: "image/jpeg" }),
    );

    expect(drawImage).toHaveBeenCalledWith(expect.any(StubImage), 256, 0, 512, 512, 0, 0, 512, 512);
    expect(result).toEqual({ mime: "image/png", avatarBase64: "AQID", byteLength: 3 });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar");
  });
});
