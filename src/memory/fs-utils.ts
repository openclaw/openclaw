import type { Stats } from "node:fs";
import fs from "node:fs/promises";

export type RegularFileStatResult = { missing: true } | { missing: false; stat: Stats };

export function isFileMissingError(
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" } {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as Partial<NodeJS.ErrnoException>).code === "ENOENT",
  );
}

export async function statRegularFile(absPath: string): Promise<RegularFileStatResult> {
  let stat: Stats;
  try {
    stat = await fs.lstat(absPath);
  } catch (err) {
    if (isFileMissingError(err)) {
      return { missing: true };
    }
    throw err;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("path required");
  }
  return { missing: false, stat };
}
