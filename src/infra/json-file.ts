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
  // Resolve any symlink on the target path so operators who redirect state
  // files to another volume (e.g. `auth-profiles.json -> /mnt/state/...`)
  // keep pointing at the same underlying file after this save. Without
  // this, the atomic rename below would replace the symlink entry itself
  // with a regular file and the old target would be silently abandoned.
  let target = pathname;
  try {
    target = fs.realpathSync(pathname);
  } catch {
    /* first write, path does not exist yet — fall through with pathname */
  }
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Atomic replace: write fully to a temp file, fsync, then rename. This
  // matters when an external process is mirroring the directory (e.g. the
  // MCTL platform s3-sync sidecar running `mc mirror` every few seconds);
  // a plain fs.writeFileSync can be observed mid-flight and ship a
  // zero-byte or truncated copy to durable storage.
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`, 0, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
  fs.chmodSync(target, 0o600);
}
