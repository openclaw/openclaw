import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

function buildSiblingTempPath(targetPath: string): string {
  const id = crypto.randomUUID();
  const safeTail = sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
  return path.join(path.dirname(targetPath), `.openclaw-output-${id}-${safeTail}.part`);
}

/**
 * Atomically write to `targetPath` via a sibling temp file and `fs.rename`.
 *
 * The `rootDir` / boundary check here is a **defense-in-depth sanity guard**,
 * not the primary security boundary. Callers are expected to validate the
 * output path at the API boundary (e.g. via `resolveWritablePathWithinRoot` in
 * the browser download routes) before reaching this helper.  Some callers
 * (like `saveDownloadPayload`) intentionally pass `rootDir = dirname(target)`
 * so the check is trivially satisfied; that is safe because the real
 * path-traversal / symlink / hardlink validation already happened upstream.
 *
 * `fs.rename` is used instead of a stream copy so that hardlink aliases at
 * the target path are safely replaced (directory-entry swap) rather than
 * written through.
 */
export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  const rootDir = await fs
    .realpath(path.resolve(params.rootDir))
    .catch(() => path.resolve(params.rootDir));
  const requestedTargetPath = path.resolve(params.targetPath);
  const targetPath = await fs
    .realpath(path.dirname(requestedTargetPath))
    .then((realDir) => path.join(realDir, path.basename(requestedTargetPath)))
    .catch(() => requestedTargetPath);
  const relativeTargetPath = path.relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === ".." ||
    relativeTargetPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTargetPath)
  ) {
    throw new Error("Target path is outside the allowed root");
  }
  const tempPath = buildSiblingTempPath(targetPath);
  let renameSucceeded = false;
  try {
    await params.writeTemp(tempPath);
    await fs.rename(tempPath, targetPath);
    renameSucceeded = true;
  } finally {
    if (!renameSucceeded) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
