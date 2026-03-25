import fs from "node:fs/promises";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

const MAX_IMAGE_BYTES = 5_000_000; // 5 MB

/**
 * Match @-prefixed image file paths in message text.
 *
 * Supported patterns:
 *   @/absolute/path/image.png
 *   @./relative/image.jpg
 *   @~/home/image.webp
 *   @"/path/with spaces/image.png"
 *   @'./path/with spaces/image.png'
 */
const IMAGE_EXT_PAT = "png|jpe?g|gif|webp|bmp|svg";
// eslint-disable-next-line no-control-regex
const IMAGE_REF_RE = new RegExp(
  `@"([^"]+?\\.(?:${IMAGE_EXT_PAT}))"` +
    `|@'([^']+?\\.(?:${IMAGE_EXT_PAT}))'` +
    `|@((?:\\/|\\.\\/|~\\/)[^\\s]+\\.(?:${IMAGE_EXT_PAT}))`,
  "gi",
);

export type ExtractedImagePaths = {
  cleanText: string;
  paths: string[];
};

export type ImageAttachment = {
  content: string;
  mimeType: string;
  fileName: string;
};

export function extractImagePaths(text: string): ExtractedImagePaths {
  const paths: string[] = [];
  const cleanText = text.replace(IMAGE_REF_RE, (_match, dqPath, sqPath, unquotedPath) => {
    const filePath = dqPath ?? sqPath ?? unquotedPath;
    if (filePath) {
      paths.push(filePath);
    }
    return "";
  });

  return {
    cleanText: cleanText.replace(/\s{2,}/g, " ").trim(),
    paths,
  };
}

function resolveImagePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.resolve(home, filePath.slice(2));
  }
  return path.resolve(filePath);
}

export async function loadImageAttachments(paths: string[]): Promise<ImageAttachment[]> {
  const attachments: ImageAttachment[] = [];

  for (const rawPath of paths) {
    const resolved = resolveImagePath(rawPath);
    const ext = path.extname(resolved).toLowerCase();

    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`not a supported image file: ${rawPath}`);
    }

    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) {
      throw new Error(`unknown image MIME type for: ${rawPath}`);
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      throw new Error(`file not found: ${rawPath}`);
    }

    if (stat.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `file too large: ${rawPath} (${stat.size} bytes, max ${MAX_IMAGE_BYTES} bytes)`,
      );
    }

    const buffer = await fs.readFile(resolved);
    const content = buffer.toString("base64");

    attachments.push({
      content,
      mimeType,
      fileName: path.basename(resolved),
    });
  }

  return attachments;
}
