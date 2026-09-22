import type { BigIntStats } from "node:fs";
import { sha256FileSync } from "@openclaw/fs-safe/durability";
import "./fs-safe-defaults.js";

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

/** Maps the borrowed-descriptor digest to OpenClaw's persisted artifact fields. */
export function hashFileDescriptorSync(
  fd: number,
  maxBytes?: number,
): { sha256: string; sizeBytes: number } {
  const { digest, bytes } = sha256FileSync(fd, { maxBytes });
  return { sha256: digest, sizeBytes: bytes };
}
