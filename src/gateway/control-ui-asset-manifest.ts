// Build-owned inventory for immutable Control UI assets.
import { createHash } from "node:crypto";
import path from "node:path";

export const CONTROL_UI_ASSET_MANIFEST_FILENAME = "asset-manifest.json";
export const CONTROL_UI_ASSET_MANIFEST_VERSION = 1;
// Shared by all retained generations; the build check holds each build to half of it.
export const CONTROL_UI_RETAINED_ASSET_MAX_BYTES = 96 * 1024 * 1024;

const CONTROL_UI_PRECOMPRESSED_ASSET_EXTENSIONS = new Set([".br", ".gz"]);

export function isControlUiPrecompressedAssetExtension(extension: string): boolean {
  return CONTROL_UI_PRECOMPRESSED_ASSET_EXTENSIONS.has(extension);
}

// Older documents request only identity URLs: bundled sidecars are not addressable,
// and a missing retained sidecar is served as identity bytes.
export function isControlUiRetainedAssetPath(assetPath: string): boolean {
  return !isControlUiPrecompressedAssetExtension(path.posix.extname(assetPath).toLowerCase());
}

export type ControlUiAssetManifestEntry = {
  path: string;
  sha256: string;
  size: number;
};

export type ControlUiAssetManifest = {
  assets: ControlUiAssetManifestEntry[];
  generation: string;
  version: typeof CONTROL_UI_ASSET_MANIFEST_VERSION;
};

export function hashControlUiAssetManifestEntries(
  entries: readonly ControlUiAssetManifestEntry[],
): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.size}\0${entry.sha256}\n`);
  }
  return hash.digest("hex");
}
