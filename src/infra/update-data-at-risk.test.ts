import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
import { verifyUpdateStateConsistency } from "./update-data-at-risk.js";
import { createRetainedCheckpointFixture } from "./update-retained-checkpoint.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "update-data-at-risk" });
});
afterEach(async () => {
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

it("finds current state consistent while this process holds the live writer", async () => {
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  openOpenClawStateDatabase();
  const stagingBefore = await fs.readdir(path.dirname(databasePath));

  await expect(verify()).resolves.toMatchObject({ status: "consistent" });
  // Read in place: no database copy is left beside the live state.
  expect(await fs.readdir(path.dirname(databasePath))).toEqual(stagingBefore);
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
