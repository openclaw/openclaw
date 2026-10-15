import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSqlitePageCacheResidency } from "./sqlite-page-cache-residency.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform !== "linux")(
  "observes cold and resident pages without warming or retaining the file",
  () => {
    const pathname = path.join(tempDirs.make("sqlite-page-cache-"), "synthetic.sqlite");
    const sizeBytes = 4 * 1024 * 1024;
    const fd = fs.openSync(pathname, "w+");
    try {
      fs.ftruncateSync(fd, sizeBytes);
      const cold = readSqlitePageCacheResidency(pathname)!;
      expect(cold).toMatchObject({
        scope: "file-sample",
        sizeBytes,
        residentPages: 0,
        residentRatio: 0,
      });
      expect(cold.sampledPages).toBeGreaterThan(2);
      expect(cold.sampledPages).toBeLessThanOrEqual(256);
      expect(readSqlitePageCacheResidency(pathname)).toEqual(cold);

      const page = Buffer.alloc(cold.pageSize, 7);
      fs.writeSync(fd, page, 0, page.length, 0);
      fs.writeSync(fd, page, 0, page.length, sizeBytes - page.length);
      expect(readSqlitePageCacheResidency(pathname)).toMatchObject({
        residentPages: 2,
        residentRatio: 2 / cold.sampledPages,
      });
    } finally {
      fs.closeSync(fd);
    }
    fs.unlinkSync(pathname);
    fs.writeFileSync(pathname, "");
    expect(readSqlitePageCacheResidency(pathname)).toMatchObject({
      sizeBytes: 0,
      sampledPages: 0,
      residentPages: 0,
      residentRatio: 1,
    });
  },
);

it.skipIf(process.platform === "linux")("does not inspect files on unsupported platforms", () => {
  expect(readSqlitePageCacheResidency("/does-not-exist/synthetic.sqlite")).toBeUndefined();
});
