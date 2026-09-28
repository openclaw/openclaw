import { crc32 } from "node:zlib";
import {
  MAX_LOBSTER_ARTWORK_BYTES,
  MAX_LOBSTER_IMAGE_DIMENSION,
  MAX_LOBSTER_PACK_BYTES,
  normalizeLobsterPackDefinition,
  type LobsterAppearance,
} from "../../packages/gateway-protocol/src/lobsterdex.js";
import { isSelfContainedSvg } from "../../packages/gateway-protocol/src/svg-image.js";
import type { PluginManifestRecord } from "./manifest-registry.types.js";
import type { PluginDiagnostic, PluginManifestLobsterPack } from "./manifest-types.js";
import { readPluginCacheFile } from "./plugin-cache-files.js";

function validateAtlas(
  bytes: Buffer,
  appearance: Extract<LobsterAppearance, { kind: "sprite-atlas" }>,
) {
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("sprite atlas must be a PNG image");
  }
  let offset = 8;
  let hasImageData = false;
  let complete = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new Error("sprite atlas contains a truncated PNG chunk");
    }
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) {
      throw new Error("sprite atlas contains an invalid PNG checksum");
    }
    if (kind === "acTL") {
      throw new Error("sprite atlas must be static PNG; core owns animation");
    }
    if (kind === "IHDR" && offset !== 8) {
      throw new Error("sprite atlas repeats PNG dimensions");
    }
    if (kind === "IDAT" && length > 0) {
      hasImageData = true;
    }
    if (kind === "IEND") {
      complete = length === 0 && end === bytes.length;
      break;
    }
    offset = end;
  }
  if (!complete || !hasImageData) {
    throw new Error("sprite atlas must contain a complete PNG image");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_LOBSTER_IMAGE_DIMENSION ||
    height > MAX_LOBSTER_IMAGE_DIMENSION ||
    width % appearance.frameWidth ||
    height % appearance.frameHeight
  ) {
    throw new Error(
      "sprite atlas dimensions must be at most 4096 and divisible by frame dimensions",
    );
  }
  const count = (width / appearance.frameWidth) * (height / appearance.frameHeight);
  if (
    appearance.reducedMotionFrame >= count ||
    Object.values(appearance.animations).some((animation) =>
      animation.frames.some((frame) => frame >= count),
    )
  ) {
    throw new Error("sprite atlas frame index is outside the image");
  }
}

/** Capture definitions and images at metadata publication, never from a request-time path. */
export function loadManifestLobsterDefinitions(params: {
  pluginId: string;
  rootDir: string;
  lobsterPacks: readonly PluginManifestLobsterPack[] | undefined;
  rejectHardlinks: boolean;
  diagnostics: PluginDiagnostic[];
}): PluginManifestRecord["lobsterDefinitions"] {
  if (!params.lobsterPacks?.length) {
    return undefined;
  }
  return params.lobsterPacks.flatMap((pack) => {
    try {
      const file = readPluginCacheFile({
        rootDir: params.rootDir,
        relativePath: pack.source,
        rejectHardlinks: params.rejectHardlinks,
        maxBytes: MAX_LOBSTER_PACK_BYTES,
      });
      if (!file.ok) {
        throw new Error("source must be a readable JSON file inside the plugin root");
      }
      const definition = normalizeLobsterPackDefinition(JSON.parse(file.contents.toString("utf8")));
      let totalBytes = 0;
      const artwork = Object.fromEntries(
        definition.clawmojis.map((entry) => {
          const imageFile = readPluginCacheFile({
            rootDir: params.rootDir,
            relativePath: entry.appearance.source,
            rejectHardlinks: params.rejectHardlinks,
            maxBytes: MAX_LOBSTER_ARTWORK_BYTES,
          });
          if (!imageFile.ok) {
            throw new Error(
              `artwork ${entry.appearance.source} must be a readable image inside the plugin root`,
            );
          }
          totalBytes += imageFile.contents.length;
          if (totalBytes > 8 * 1024 * 1024) {
            throw new Error("pack artwork must total at most 8 MiB");
          }
          if (entry.appearance.kind === "svg") {
            const svg = imageFile.contents.toString("utf8");
            // Packs use static presentation attributes; core alone owns animation and reduced motion.
            if (
              imageFile.contents.length > 64 * 1024 ||
              !isSelfContainedSvg(svg) ||
              /<\s*(?:[\w.-]+:)?(?:style|animate\w*|set|discard|script|foreignObject|image|use|iframe)\b|\b(?:style|on[\w:-]+)\s*=|url\s*\(/iu.test(
                svg,
              )
            ) {
              throw new Error(
                "artwork must be a self-contained SVG with static presentation attributes",
              );
            }
          } else {
            validateAtlas(imageFile.contents, entry.appearance);
          }
          return [
            entry.id,
            {
              data: imageFile.contents.toString("base64"),
              mimeType: entry.appearance.kind === "svg" ? "image/svg+xml" : "image/png",
            },
          ];
        }),
      );
      return [{ id: pack.id, definition, artwork }];
    } catch (error) {
      params.diagnostics.push({
        level: "warn",
        pluginId: params.pluginId,
        message: `lobster pack ${pack.id} is unavailable: ${error instanceof Error ? error.message : "invalid definition"}`,
      });
      return [];
    }
  });
}
