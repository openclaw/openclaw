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
  // Follow the full symlink chain one hop at a time. `realpathSync` would
  // resolve the chain for us but throws when any link in the chain points
  // at a missing file — which is exactly the case on a fresh boot where
  // the first save is the *creating* write. Manual lstat+readlink keeps
  // working in that case and also handles multi-hop chains (A -> B ->
  // real.json) so we rename onto `real.json` rather than silently
  // clobbering `B` with a regular file.
  let target = pathname;
  const visited = new Set<string>();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (visited.has(target)) {
      throw new Error(`saveJsonFile: symlink cycle detected at ${target}`);
    }
    visited.add(target);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(target);
    } catch {
      /* path does not exist yet — break out and write to target */
      break;
    }
    if (!st.isSymbolicLink()) {
      break;
    }
    const hop = fs.readlinkSync(target);
    target = path.isAbsolute(hop) ? hop : path.resolve(path.dirname(target), hop);
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
    // fs.writeFileSync on an fd loops internally until every byte has
    // landed, so a short write under file-size / quota / low-disk
    // conditions surfaces as an actual ENOSPC instead of silently
    // truncating the payload. fsync then makes it durable before the
    // rename swaps the entry.
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
