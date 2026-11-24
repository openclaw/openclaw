import "../test-utils/prepare-compiled-subprocesses.js";
import "../infra/database-engine/backup-worker.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabasePortPostgres } from "../infra/database-engine/port-provider.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { clonePostgresUpgradeInWorker } from "./database-backup.operations.js";

vi.mock("../infra/database-engine/port-provider.js", async (original) => ({
  ...(await original<typeof import("../infra/database-engine/port-provider.js")>()),
  withDatabasePortPostgres: vi.fn(),
}));

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.resetAllMocks());

it("names server disk exhaustion without changing the original PostgreSQL anchor", async () => {
  const directory = directories.make("postgres-upgrade-space-");
  const sourcePath = path.join(directory, "source.sqlite");
  {
    using anchor = openNodeSqliteDatabase(sourcePath);
    anchor.exec(
      "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
    );
    anchor
      .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
      .run("36b2f1c0-7ba5-409d-88cd-613788754312", "source_namespace");
  }
  const before = fs.readFileSync(sourcePath);
  vi.mocked(withDatabasePortPostgres).mockRejectedValueOnce(
    Object.assign(new Error("could not extend file: No space left on device"), { code: "53100" }),
  );
  await expect(
    clonePostgresUpgradeInWorker({
      sourcePath,
      anchorPath: path.join(directory, "private.sqlite"),
      config: {},
      assertCurrent() {},
    }),
  ).rejects.toThrow("Free space on the PostgreSQL server, then run openclaw update.");
  expect(fs.readFileSync(sourcePath)).toEqual(before);
});
