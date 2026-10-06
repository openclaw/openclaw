import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as fsSafeCopy from "@openclaw/fs-safe/copy";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { configureSqliteWalMaintenance } from "./sqlite-wal.js";

vi.mock("@openclaw/fs-safe/copy", () => ({ probeTreeClone: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform !== "win32").each(["apfs", "unknown", "failed", "aliased"])(
  "preserves a WAL peer through a mount timeout only with canonical APFS evidence: %s",
  (classification) => {
    const root = fs.realpathSync(tempDirs.make("openclaw-wal-mount-timeout-"));
    const directory = path.join(root, "database");
    fs.mkdirSync(directory);
    const alias = path.join(root, "alias");
    if (classification === "aliased") {
      fs.symlinkSync(directory, alias);
    }
    const databasePath = path.join(
      classification === "aliased" ? alias : directory,
      "state.sqlite",
    );
    const { DatabaseSync } = requireNodeSqlite();
    const first = new DatabaseSync(databasePath);
    first.exec("PRAGMA journal_mode=WAL; CREATE TABLE records(value TEXT);");
    const second = new DatabaseSync(databasePath);
    let maintenance: ReturnType<typeof configureSqliteWalMaintenance> | undefined;
    try {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("no proc mountinfo");
      });
      vi.spyOn(childProcess, "execFileSync").mockImplementation(() => {
        throw Object.assign(new Error("mount classification timed out"), { code: "ETIMEDOUT" });
      });
      vi.mocked(fsSafeCopy.probeTreeClone).mockImplementation(() => {
        if (classification === "failed") {
          throw new Error("native filesystem inspection failed");
        }
        return classification === "unknown" ? undefined : "apfs";
      });
      const configure = () =>
        configureSqliteWalMaintenance(second, { databasePath, checkpointIntervalMs: 0 });
      if (classification === "apfs") {
        maintenance = configure();
        second.exec("INSERT INTO records VALUES ('second');");
      } else {
        expect(configure).toThrow(/database is locked/);
      }
      first.exec("INSERT INTO records VALUES ('first');");
      expect(first.prepare("PRAGMA journal_mode;").get()).toEqual({ journal_mode: "wal" });
      expect(first.prepare("SELECT value FROM records ORDER BY value").all()).toEqual(
        classification === "apfs"
          ? [{ value: "first" }, { value: "second" }]
          : [{ value: "first" }],
      );
    } finally {
      maintenance?.close();
      second.close();
      first.close();
    }
  },
);
