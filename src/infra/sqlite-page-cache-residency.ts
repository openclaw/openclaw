import fs from "node:fs";
import { samplePageCacheResidency } from "@openclaw/proc-safe/diagnostics";

export type SqlitePageCacheResidency = {
  scope: "file-sample";
  sampledPages: number;
  residentPages: number;
  residentRatio: number;
  pageSize: number;
  sizeBytes: number;
};

/** Worker-only, bounded file residency sample; it does not identify SQLite's logical hot set. */
export function readSqlitePageCacheResidency(
  pathname: string,
): SqlitePageCacheResidency | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }
  const fd = fs.openSync(pathname, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("SQLite page-cache residency requires a regular file");
    }
    const { sampledPages, residentPages, pageSize } = samplePageCacheResidency(fd, {
      maxPages: 256,
    });
    return {
      scope: "file-sample",
      sampledPages,
      residentPages,
      residentRatio: sampledPages === 0 ? 1 : residentPages / sampledPages,
      pageSize,
      sizeBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}
