import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { isPathInside } from "../infra/path-guards.js";

const LCM_FILE_REF_TOKEN_SOURCE =
  "(?:^|[^A-Za-z0-9_./\\\\-])(?:file_ref:|externalized\\s+)?(file_[a-f0-9]{16})(?![A-Za-z0-9_.-])";
const LCM_IMAGE_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg", ".gif", ".svg"] as const;

const lcmFileRefExtractPattern = new RegExp(LCM_FILE_REF_TOKEN_SOURCE, "i");

export const LCM_FILE_REF_SCAN_PATTERN = new RegExp(LCM_FILE_REF_TOKEN_SOURCE, "gi");

export type LcmImageFileReference = {
  fileRef: string;
  path: string;
  root: string;
};

export function extractLcmImageFileReference(input: string): string | null {
  const match = input.match(lcmFileRefExtractPattern);
  return match?.[1]?.toLowerCase() ?? null;
}

export function resolveLcmFilesRoot(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "lcm-files");
}

export async function resolveLcmImageFileReference(
  input: string,
  options?: { stateDir?: string },
): Promise<LcmImageFileReference | null> {
  const fileRef = extractLcmImageFileReference(input);
  if (!fileRef) {
    return null;
  }

  const root = resolveLcmFilesRoot(options?.stateDir);
  let rootRealPath: string;
  try {
    rootRealPath = await fs.realpath(root);
  } catch {
    return null;
  }

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(rootRealPath, { withFileTypes: true });
  } catch {
    return null;
  }

  let resolved: LcmImageFileReference | null = null;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const conversationDir = path.join(rootRealPath, entry.name);
    for (const ext of LCM_IMAGE_EXTENSIONS) {
      const candidate = path.join(conversationDir, `${fileRef}${ext}`);
      try {
        const stat = await fs.lstat(candidate);
        if (!stat.isFile()) {
          continue;
        }
        const candidateRealPath = await fs.realpath(candidate);
        if (!isPathInside(rootRealPath, candidateRealPath)) {
          continue;
        }
        if (resolved) {
          return null;
        }
        resolved = { fileRef, path: candidateRealPath, root: rootRealPath };
      } catch {
        // Try the next allowed image extension/conversation directory.
      }
    }
  }

  return resolved;
}
