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
  //
  // Using lstat + readlink (instead of realpathSync) on purpose: the first
  // save after a fresh pod boot is often the *creating* write, so the
  // symlink target does not exist yet. realpathSync would throw in that
  // case and we would fall back to renaming over the link itself. lstat
  // tells us whether `pathname` is a symlink without touching its target,
  // and readlink gives us the target path we should be renaming onto.
  let target = pathname;
  let isSymlink = false;
  try {
    isSymlink = fs.lstatSync(pathname).isSymbolicLink();
  } catch {
    /* path does not exist at all — fresh write, use pathname */
  }
  if (isSymlink) {
    const linkTarget = fs.readlinkSync(pathname);
    target = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(pathname), linkTarget);
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
