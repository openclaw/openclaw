import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { readUpdateDatabaseGenerationsIsolated } from "../../infra/update-candidate-state.inspection.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { adoptUpdateBootDatabaseWrites } from "./update-command-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function write(pathname: string, value: string) {
  using db = openNodeSqliteDatabase(pathname);
  db.exec("CREATE TABLE IF NOT EXISTS rows (value TEXT)");
  db.prepare("INSERT INTO rows VALUES (?)").run(value);
}

async function migrated() {
  const stateDir = dirs.make("boot-writes-");
  const pathname = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  write(pathname, "migrated by Doctor");
  const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const to = await readUpdateDatabaseGenerationsIsolated([pathname], { env });
  const backup = {
    databases: [{ path: pathname }],
    missingPaths: [],
    sourceGenerations: {},
    migration: { name: "openclaw doctor", backup: "/backup", from: {}, to },
  } as UpdateDatabaseBackup;
  return { pathname, env, backup, to };
}

const failedBoot = (pathname: string) => async (): Promise<UpdateRunResult> => {
  write(pathname, "gateway boot bookkeeping");
  return { status: "error", mode: "git", steps: [], durationMs: 0 };
};

it("attributes a failed activated boot's own writes to the update so rollback can restore", async () => {
  const { pathname, env, backup, to } = await migrated();

  await adoptUpdateBootDatabaseWrites(backup, env, failedBoot(pathname));

  const current = await readUpdateDatabaseGenerationsIsolated([pathname], { env });
  expect(current).not.toEqual(to);
  expect(backup.migration?.to).toEqual(current);
});

it("keeps the rollback refusal when another writer changed the databases after Doctor", async () => {
  const { pathname, env, backup, to } = await migrated();
  write(pathname, "operator write after Doctor");

  await adoptUpdateBootDatabaseWrites(backup, env, failedBoot(pathname));

  expect(backup.migration?.to).toEqual(to);
});
