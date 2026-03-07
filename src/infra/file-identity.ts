export type FileIdentityStat = {
  dev: number | bigint;
  ino: number | bigint;
};

export function sameFileIdentity(
  left: FileIdentityStat,
  right: FileIdentityStat,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (left.ino !== right.ino) {
    return false;
  }

  // On Windows, lstatSync (path-based) and fstatSync (fd-based) report
  // different dev values for the same file — one may be zero while the other
  // holds a volume serial, or both may be non-zero but differ due to encoding
  // differences between the two syscall paths. Cross-volume inode collision is
  // theoretically possible but astronomically unlikely on NTFS (file reference
  // numbers are 64-bit per-volume). Accepting dev mismatch when ino matches is
  // a pragmatic trade-off: without it, plugin manifest validation rejects every
  // plugin on Windows.
  if (left.dev === right.dev) {
    return true;
  }
  return platform === "win32";
}
