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
  // Atomic replace: write fully to a temp file, fsync, then rename. This
  // matters when an external process is mirroring the directory (e.g. the
  // MCTL platform s3-sync sidecar running `mc mirror` every few seconds);
  // a plain fs.writeFileSync can be observed mid-flight and ship a
  // zero-byte or truncated copy to durable storage.
  const tmp = `${pathname}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`, 0, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, pathname);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
  fs.chmodSync(pathname, 0o600);
}
