import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as snapshotSource from "./sqlite-snapshot-source.js";
import { verifyUpdateStateConsistency } from "./update-data-at-risk.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "update-data-at-risk" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  await state.cleanup();
});

const verify = () =>
  verifyUpdateStateConsistency({ env: process.env, formatCommand: (command) => command });

function setStateUserVersion(version: number) {
  closeOpenClawStateDatabaseForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(resolveOpenClawStateSqlitePath(process.env));
  try {
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
}

it("reads current state in place beside an open write transaction", async () => {
  openOpenClawStateDatabase();
  const copies = vi.spyOn(snapshotSource, "prepareSqliteReadOnlyLocation");
  const { DatabaseSync } = requireNodeSqlite();
  const writer = new DatabaseSync(resolveOpenClawStateSqlitePath(process.env));
  try {
    writer.exec("BEGIN IMMEDIATE");

    await expect(verify()).resolves.toMatchObject({ status: "consistent" });
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  // A live Gateway can hold a multi-gigabyte database; verification must not copy it.
  expect(copies).not.toHaveBeenCalled();
});

it("refuses state written at a newer schema than this build supports", async () => {
  openOpenClawStateDatabase();
  setStateUserVersion(OPENCLAW_STATE_SCHEMA_VERSION + 1);

  const verdict = await verify();

  expect(verdict).toMatchObject({ status: "inconsistent" });
  expect(verdict.detail).toContain(`schema ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
  expect(verdict.status !== "consistent" && verdict.nextAction).toContain("`openclaw update`");
});

it("refuses state whose migration to this build did not finish", async () => {
  openOpenClawStateDatabase();
  setStateUserVersion(OPENCLAW_STATE_SCHEMA_VERSION - 1);

  const verdict = await verify();

  expect(verdict).toMatchObject({ status: "inconsistent" });
  expect(verdict.status !== "consistent" && verdict.nextAction).toContain(
    "`openclaw doctor --fix`",
  );
  expect(verdict.detail).toContain("migration did not finish");
});

it("refuses while an interrupted state restore is still on disk", async () => {
  openOpenClawStateDatabase();
  closeOpenClawStateDatabaseForTest();
  const directory = path.dirname(resolveOpenClawStateSqlitePath(process.env));
  await fs.mkdir(path.join(directory, ".openclaw-restore-interrupted"));

  const verdict = await verify();

  expect(verdict).toMatchObject({ status: "inconsistent" });
  expect(verdict.detail).toContain("Interrupted shared-database publication");
  expect(verdict.status !== "consistent" && verdict.nextAction).toContain(
    "repair-and-recovery#interrupted-state-restore",
  );
});

it("reports an unlistable state directory as unverifiable, not as an interrupted restore", async () => {
  openOpenClawStateDatabase();
  closeOpenClawStateDatabaseForTest();
  const directory = path.dirname(resolveOpenClawStateSqlitePath(process.env));
  // Files stay reachable by name; only listing for restore directories fails.
  await fs.chmod(directory, 0o300);
  try {
    const verdict = await verify();

    expect(verdict).toMatchObject({ status: "unverifiable" });
    expect(verdict.detail).not.toContain("restore did not finish");
  } finally {
    await fs.chmod(directory, 0o700);
  }
});

it("refuses while an earlier update's state recovery is unfinished", async () => {
  const fixture = createRetainedCheckpointFixture(state.path("retained"));

  const verdict = await verifyUpdateStateConsistency({
    env: fixture.env,
    formatCommand: (command) => command,
  });

  expect(verdict).toMatchObject({
    status: "inconsistent",
    detail: `update ${fixture.run.runId} has unfinished state recovery`,
  });
});

it("reports unreadable state as unverifiable instead of consistent", async () => {
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  await fs.writeFile(databasePath, "not a sqlite database".repeat(256));

  const verdict = await verify();

  expect(verdict).toMatchObject({ status: "unverifiable" });
  expect(verdict.status !== "consistent" && verdict.nextAction).toContain(
    "`openclaw update repair`",
  );
});
