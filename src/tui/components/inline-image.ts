// Inline image rendering utilities for the TUI.
// Reads local MEDIA: image files and creates pi-tui Image components
// when the terminal supports Kitty or iTerm2 graphics protocols.

import { lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute, normalize } from "node:path";
import { Image, getCapabilities, getImageDimensions, type ImageTheme } from "@mariozechner/pi-tui";
import { MAX_IMAGE_BYTES } from "../../media/constants.js";
import { theme } from "../theme/theme.js";

export const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_EXTS = new Set(Object.keys(MIME_BY_EXT));

const imageTheme: ImageTheme = {
  fallbackColor: (str: string) => theme.dim(str),
};

let _cachedCapable: boolean | undefined;

/** Whether the current terminal supports inline image rendering. */
export function canRenderInlineImages(): boolean {
  if (_cachedCapable === undefined) {
    _cachedCapable = getCapabilities().images !== null;
  }
  return _cachedCapable;
}

/**
 * Read a local image file and return its base64 data + MIME type.
 * Returns null on any validation failure (wrong extension, too large,
 * symlink, relative path, traversal, etc). Never throws.
 */
export function readMediaImageAsBase64(
  filePath: string,
): { data: string; mimeType: string } | null {
  try {
    if (!filePath || !isAbsolute(filePath)) {
      return null;
    }
    if (filePath.includes("\0")) {
      return null;
    }
    // Normalize to resolve any .. segments and inconsistent separators
    // before extension/stat checks. This is a local TUI reading local files
    // (no remote clients), so normalization is sufficient defense-in-depth.
    const cleaned = normalize(filePath);

    const ext = extname(cleaned).toLowerCase();
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) {
      return null;
    }

    const stat = lstatSync(cleaned);
    if (!stat.isFile()) {
      return null; // rejects symlinks, directories, etc.
    }
    if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      return null;
    }

    const buf = readFileSync(cleaned);
    if (buf.length > MAX_IMAGE_BYTES) {
      return null; // TOCTOU guard
    }

    return { data: buf.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

/** Create a pi-tui Image component for inline rendering. */
export function createInlineImage(
  base64Data: string,
  mimeType: string,
  opts?: { maxWidthCells?: number; filename?: string },
): Image {
  const dims = getImageDimensions(base64Data, mimeType) ?? undefined;
  return new Image(
    base64Data,
    mimeType,
    imageTheme,
    {
      maxWidthCells: opts?.maxWidthCells ?? 60,
      filename: opts?.filename,
    },
    dims,
  );
}

/** Check whether a file extension is a supported image type. */
export function isSupportedImageExt(ext: string): boolean {
  return IMAGE_EXTS.has(ext.toLowerCase());
}

/** Reset the cached capability flag (for testing). */
export function _resetCapabilityCache(): void {
  _cachedCapable = undefined;
}
