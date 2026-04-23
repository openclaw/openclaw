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
  // Follow the full symlink chain one hop at a time so operators who
  // redirect state files onto another volume (e.g. `auth-profiles.json ->
  // /mnt/state/...`) keep pointing at the same underlying file. The atomic
  // rename at the end is onto the resolved target, not the link entry, so
  // the symlink itself is preserved.
  //
  // realpathSync would do this in one call, but it throws when any link in
  // the chain points at a missing file — which is exactly the case on a
  // fresh boot when the first save is the *creating* write. Manual
  // lstat+readlink keeps working in that case and also handles multi-hop
  // chains (A -> B -> real.json) so we rename onto `real.json` rather
  // than silently clobbering `B` with a regular file.
  let target = pathname;
  let followedSymlink = false;
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
    followedSymlink = true;
    const hop = fs.readlinkSync(target);
    target = path.isAbsolute(hop) ? hop : path.resolve(path.dirname(target), hop);
  }
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) {
    // Auto-creating missing parent directories is only safe on the original
    // callsite path — operators who redirect state via a symlink usually
    // expect the destination volume to be mounted by the orchestrator
    // (PVC, bind mount, etc.). Silently materialising the tree locally
    // would split state across the real target and a stub directory the
    // next boot's mount would hide. Fail loud so the bad mount surfaces
    // as an error instead of silent data divergence.
    if (followedSymlink) {
      throw new Error(
        `saveJsonFile: symlink target directory does not exist: ${dir} (from ${pathname})`,
      );
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  // Atomic replace: write fully to a temp file, fsync, then rename. This
  // matters when an external process is mirroring the directory (e.g. the
  // MCTL platform s3-sync sidecar running `mc mirror` every few seconds);
  // a plain fs.writeFileSync can be observed mid-flight and ship a
  // zero-byte or truncated copy to durable storage.
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  try {
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
    fs.renameSync(tmp, target);
  } catch (err) {
    // Any failure between openSync and renameSync (ENOSPC on write, EIO on
    // fsync, stringify throwing on a cyclic object, cross-device rename, …)
    // must drop the partial temp file so external mirrors do not ship it as
    // real state and the workspace is not left with accumulating `.tmp.*`
    // siblings on repeated failures.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
  fs.chmodSync(target, 0o600);
}
