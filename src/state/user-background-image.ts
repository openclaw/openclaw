import { readImageProbeFromHeader } from "rastermill";
import {
  USER_BACKGROUND_MAX_INPUT_BYTES,
  USER_BACKGROUND_MAX_OUTPUT_BYTES,
} from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import { isAnimatedWebpBuffer } from "../media/image-ops.js";
import { createImageProcessorWithPixelLimits } from "../media/image-processor.js";

export class UserBackgroundInputError extends Error {}

function isAnimatedPng(bytes: Buffer): boolean {
  // APNG animation control precedes frame data; walk bounded chunk lengths, not arbitrary text.
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) {
      throw new UserBackgroundInputError("Invalid PNG chunk length");
    }
    if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL") {
      return true;
    }
    offset += length + 12;
  }
  return false;
}

/** Never retain the original: decode a bounded static raster and strip source metadata. */
export async function normalizeUserBackgroundImage(imageBase64: string, signal?: AbortSignal) {
  if (
    !imageBase64 ||
    imageBase64.length > 4 * Math.ceil(USER_BACKGROUND_MAX_INPUT_BYTES / 3) ||
    imageBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)
  ) {
    throw new UserBackgroundInputError(
      "Upload must contain a base64-encoded image of at most 8 MiB",
    );
  }
  const bytes = Buffer.from(imageBase64, "base64");
  const probe = readImageProbeFromHeader(bytes);
  if (
    !probe ||
    bytes.length > USER_BACKGROUND_MAX_INPUT_BYTES ||
    !["jpeg", "png", "webp"].includes(probe.format) ||
    probe.width < 1 ||
    probe.height < 1 ||
    probe.width * probe.height > 25_000_000 ||
    (probe.format === "webp" && isAnimatedWebpBuffer(bytes)) ||
    (probe.format === "png" && isAnimatedPng(bytes))
  ) {
    throw new UserBackgroundInputError(
      "Choose a static JPEG, PNG, or WebP image up to 25 megapixels",
    );
  }
  const image = await createImageProcessorWithPixelLimits({
    inputPixels: 25_000_000,
    outputPixels: 2560 * 2560,
  }).encode(bytes, {
    format: "jpeg",
    autoOrient: true,
    metadata: "strip",
    signal,
    resize: { maxSide: 2560, enlarge: false },
    maxBytes: USER_BACKGROUND_MAX_OUTPUT_BYTES,
    search: { maxSide: [2560, 1920, 1280], quality: [85, 70] },
  });
  if (
    image.data.byteLength === 0 ||
    image.data.byteLength > USER_BACKGROUND_MAX_OUTPUT_BYTES ||
    image.width > 2560 ||
    image.height > 2560 ||
    image.format !== "jpeg" ||
    image.metadata !== "stripped"
  ) {
    throw new UserBackgroundInputError("Image could not fit the 2 MiB background limit");
  }
  return { image: image.data, width: image.width, height: image.height };
}
