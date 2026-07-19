/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeAvatarBlob,
  fitAvatarDimensions,
  MAX_PROFILE_AVATAR_BYTES,
  MAX_PROFILE_AVATAR_SOURCE_BYTES,
  processProfileAvatar,
  ProfileAvatarError,
} from "./avatar-processing.ts";

describe("profile avatar processing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fits either orientation inside 256 by 256 without upscaling", () => {
    expect(fitAvatarDimensions(1024, 512)).toEqual({ width: 256, height: 128 });
    expect(fitAvatarDimensions(300, 900)).toEqual({ width: 85, height: 256 });
    expect(fitAvatarDimensions(80, 60)).toEqual({ width: 80, height: 60 });
  });

  it("encodes accepted bytes and enforces the 512 KB hard cap", async () => {
    const encoded = await encodeAvatarBlob(new Blob([new Uint8Array([0, 1, 2, 255])]), "image/png");
    expect(encoded).toEqual({ mime: "image/png", avatarBase64: "AAEC/w==", byteLength: 4 });

    await expect(
      encodeAvatarBlob(new Blob([new Uint8Array(MAX_PROFILE_AVATAR_BYTES + 1)]), "image/webp"),
    ).rejects.toMatchObject({ code: "too-large" } satisfies Partial<ProfileAvatarError>);
  });

  it("rejects unreasonable source files before browser image decoding", async () => {
    await expect(
      processProfileAvatar(
        new File([new Uint8Array(MAX_PROFILE_AVATAR_SOURCE_BYTES + 1)], "avatar.png", {
          type: "image/png",
        }),
      ),
    ).rejects.toMatchObject({ code: "source-too-large" } satisfies Partial<ProfileAvatarError>);
  });

  it("decodes, downsizes, and encodes an uploaded image before the RPC payload", async () => {
    const createObjectURL = vi.fn(() => "blob:avatar");
    const revokeObjectURL = vi.fn();
    class StubUrl extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    }
    class StubImage {
      decoding = "auto";
      src = "";
      naturalWidth = 1024;
      naturalHeight = 512;
      decode = vi.fn(async () => undefined);
    }
    vi.stubGlobal("URL", StubUrl);
    vi.stubGlobal("Image", StubImage);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
      callback(new Blob([new Uint8Array([1, 2, 3])], { type: type ?? "image/png" }));
    });

    const result = await processProfileAvatar(
      new File(["source"], "avatar.jpg", { type: "image/jpeg" }),
    );

    expect(drawImage).toHaveBeenCalledWith(expect.any(StubImage), 0, 0, 256, 128);
    expect(result).toEqual({ mime: "image/png", avatarBase64: "AQID", byteLength: 3 });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar");
  });
});
