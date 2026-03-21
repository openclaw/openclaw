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
 * Write a file with 0o600 permissions atomically (no TOCTOU gap).
 *
 * Uses openSync with O_CREAT|O_TRUNC to create/truncate the file, then
 * fchmodSync on the fd to set permissions regardless of umask, before writing
 * content. This avoids the race between writeFileSync and chmodSync where the
 * file briefly exists with wider permissions.
 */
export function writeFileSecure(filePath: string, content: string): void {
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, content, 0, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeFileSecure(pathname, `${JSON.stringify(data, null, 2)}\n`);
}
