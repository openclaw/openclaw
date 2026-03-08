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

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const content = `${JSON.stringify(data, null, 2)}\n`;
  // Atomic write: write to a temp file in the same directory, then rename.
  // rename() is atomic on the same filesystem, preventing corruption on crash.
  const tmpPath = path.join(
    dir,
    `.${path.basename(pathname)}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, pathname);
  } catch (err) {
    // Clean up the temp file if rename failed.
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }
}
