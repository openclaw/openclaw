import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Atomically write JSON to disk: serialize to a temp file in the same
 * directory, then `fs.renameSync` over the target.  `rename(2)` is atomic
 * on POSIX when source and destination live on the same filesystem, so
 * concurrent readers never see a half-written file.
 */
export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const content = `${JSON.stringify(data, null, 2)}\n`;
  // Temp file in the same directory guarantees same filesystem for atomic rename.
  const tmpPath = path.join(dir, `.${path.basename(pathname)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, pathname);
  } catch (err) {
    // Clean up the temp file on failure so we don't leave orphans.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors (file may not exist).
    }
    throw err;
  }
}
