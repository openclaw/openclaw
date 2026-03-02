import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

function sanitizeFileNameTail(fileName: string): string {
  const trimmed = String(fileName ?? "").trim();
  if (!trimmed) {
    return "output.bin";
  }
  let base = path.posix.basename(trimmed);
  base = path.win32.basename(base);
  let cleaned = "";
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      continue;
    }
    cleaned += base[i];
  }
  base = cleaned.trim();
  if (!base || base === "." || base === "..") {
    return "output.bin";
  }
  if (base.length > 200) {
    base = base.slice(0, 200);
  }
  return base;
}

function buildSiblingTempPath(targetPath: string): string {
  const id = crypto.randomUUID();
  const safeTail = sanitizeFileNameTail(path.basename(targetPath));
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
