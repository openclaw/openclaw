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

  // On Windows, path-based stat (lstatSync) and fd-based stat (fstatSync)
  // can report different dev values for the same file: one may be zero, or
  // both may be non-zero but differ (volume serial encoding varies by call
  // type). When ino already matches, accept dev mismatch on win32.
  if (left.dev === right.dev) {
    return true;
  }
  return platform === "win32";
}
