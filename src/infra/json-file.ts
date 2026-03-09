import { randomUUID } from "node:crypto";
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
 * Atomically write a JSON file by writing to a temporary file first,
 * then renaming it to the target path.  `rename(2)` is atomic on POSIX
 * filesystems, which prevents concurrent writes from producing truncated
 * or interleaved JSON (see #40471).
 */
export function saveJsonFile(pathname: string, data: unknown) {
  // Resolve symlinks (including dangling ones) so rename replaces the
  // target file, not the link itself.
  let resolved = pathname;
  try {
    if (fs.lstatSync(pathname).isSymbolicLink()) {
      try {
        resolved = fs.realpathSync(pathname);
      } catch {
        // Dangling symlink — resolve the link target manually.
        resolved = path.resolve(path.dirname(pathname), fs.readlinkSync(pathname));
      }
    }
  } catch {
    // pathname does not exist yet — use it as-is
  }
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${resolved}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best-effort; ignore on platforms without chmod support
    }
    fs.renameSync(tmp, resolved);
    try {
      fs.chmodSync(resolved, 0o600);
    } catch {
      // best-effort; ignore on platforms without chmod support
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
