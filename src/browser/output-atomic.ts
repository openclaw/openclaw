import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

function buildSiblingTempPath(targetPath: string): string {
  const id = crypto.randomUUID();
  const safeTail = sanitizeUntrustedFileName(path.basename(targetPath), "output.bin");
  return path.join(path.dirname(targetPath), `.openclaw-output-${id}-${safeTail}.part`);
}

export async function writeViaSiblingTempPath(params: {
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  const targetPath = path.resolve(params.targetPath);
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
