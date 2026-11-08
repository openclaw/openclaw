import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { moveSqliteFilesAside } from "./sqlite-recovery-files.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("preserves moved sidecars instead of restoring them after maintenance authority is lost", () => {
  const directory = tempDirs.make("sqlite-recovery-authority-");
  const databasePath = path.join(directory, "database.sqlite");
  fs.writeFileSync(databasePath, "original database bytes");
  fs.writeFileSync(`${databasePath}-wal`, "original WAL bytes");
  let checks = 0;

  expect(() =>
    moveSqliteFilesAside(databasePath, () => {
      checks += 1;
      if (checks > 1) {
        throw new Error("maintenance authority lost");
      }
    }),
  ).toThrow("maintenance authority lost");

  expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
  expect(fs.readFileSync(databasePath, "utf8")).toBe("original database bytes");
  const preserved = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("database.sqlite-wal.corrupt-"));
  expect(preserved).toHaveLength(1);
  expect(fs.readFileSync(path.join(directory, preserved[0]!), "utf8")).toBe("original WAL bytes");
});
