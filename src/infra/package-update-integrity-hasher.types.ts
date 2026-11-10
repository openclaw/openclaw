import type { BigIntStats } from "node:fs";

type FileIdentity = Pick<
  BigIntStats,
  "dev" | "ino" | "mode" | "uid" | "gid" | "nlink" | "size" | "mtimeNs" | "ctimeNs"
>;

export type PackageFileHashJob = FileIdentity & { file: string };
export type HashError = {
  message: string;
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
};
export type HashResult = { digest: string } | { error: HashError } | { cancelled: true };
