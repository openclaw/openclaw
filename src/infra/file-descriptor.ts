import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { openRootFileSync } from "@openclaw/fs-safe/advanced";
import { sha256FileSync } from "@openclaw/fs-safe/durability";

export {
  copyFileHandle,
  overwriteFileHandle,
  writeFileWindowFully,
} from "@openclaw/fs-safe/advanced";

export type FileMutationFingerprint = Pick<
  BigIntStats,
  "birthtimeNs" | "ctimeNs" | "dev" | "ino" | "mtimeNs" | "size"
>;

/** Strict field equality; callers own any platform-specific identity tolerance. */
export function sameFileMutationFingerprint(
  left: FileMutationFingerprint,
  right: FileMutationFingerprint,
): boolean {
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

export type FileMutationMetadata = FileMutationFingerprint &
  Pick<BigIntStats, "mode" | "uid" | "gid">;

/** Link churn changes ctime on Windows and POSIX; admitting it still requires matching bytes. */
export function sameFileMutationMetadata(
  left: FileMutationMetadata,
  right: FileMutationMetadata,
): boolean {
  // Without statx, Linux libuv synthesizes birthtime from ctime. Real birthtime
  // changes still fail; this exact fallback shape requires the caller's byte proof.
  const derivedBirthtime =
    process.platform === "linux" &&
    left.birthtimeNs === left.ctimeNs &&
    right.birthtimeNs === right.ctimeNs;
  return (
    sameFileMutationFingerprint(left, {
      ...right,
      ctimeNs: left.ctimeNs,
      birthtimeNs: derivedBirthtime ? left.birthtimeNs : right.birthtimeNs,
    }) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

/** Hash a pinned regular file without accepting replacement or non-link metadata changes. */
export function hashFileMutationSnapshotSync(
  filePath: string,
  expected: FileMutationMetadata,
): string {
  const changed = () => new Error(`File changed while hashing snapshot: ${filePath}`);
  const opened = openRootFileSync({
    absolutePath: filePath,
    rootPath: path.dirname(filePath),
    boundaryLabel: "file snapshot",
    maxBytes: Number(expected.size),
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    throw new Error(`Cannot open file snapshot: ${filePath}`, { cause: opened.error });
  }
  const assertStat = (current: BigIntStats) => {
    if (!current.isFile() || !sameFileMutationMetadata(expected, current)) {
      throw changed();
    }
    return current;
  };
  try {
    let digest: string | undefined;
    // Never return a digest across an unverified ctime window. A retry must
    // observe identical bytes and a stable descriptor/path through the final stat.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = assertStat(fs.fstatSync(opened.fd, { bigint: true }));
      const content = hashFileDescriptorSync(opened.fd, Number(expected.size));
      const after = assertStat(fs.fstatSync(opened.fd, { bigint: true }));
      const current = assertStat(fs.lstatSync(filePath, { bigint: true }));
      if (
        content.sizeBytes !== Number(expected.size) ||
        (digest !== undefined && content.sha256 !== digest)
      ) {
        throw changed();
      }
      digest = content.sha256;
      if (
        sameFileMutationFingerprint(before, after) &&
        sameFileMutationFingerprint(after, current)
      ) {
        return digest;
      }
    }
    throw changed();
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Maps the borrowed-descriptor digest to OpenClaw's persisted artifact fields. */
export function hashFileDescriptorSync(
  fd: number,
  maxBytes?: number,
): { sha256: string; sizeBytes: number } {
  const { digest, bytes } = sha256FileSync(fd, { maxBytes });
  return { sha256: digest, sizeBytes: bytes };
}
