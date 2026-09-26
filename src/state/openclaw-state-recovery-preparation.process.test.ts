import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  assertPreparedAgentRecoveryRepresentation,
  prepareOpenClawStateRecoveryCopy,
} from "./openclaw-state-recovery-preparation.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture(version: 17 | 19) {
  const root = await fs.realpath(tempDirs.make("recovery-state-worker-"));
  const baselinePath = path.join(root, "baseline.sqlite");
  const candidatePath = path.join(root, "candidate.sqlite");
  const targetPath = path.join(root, "prepared.sqlite");
  const database = openNodeSqliteDatabase(baselinePath);
  try {
    database.exec(`PRAGMA user_version=${version};
      CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT, schema_version INTEGER, app_version TEXT);
      INSERT INTO schema_meta VALUES('primary','global',NULL,${version},'before');
      CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT);
      CREATE TABLE acknowledged(id TEXT PRIMARY KEY, value TEXT);
      INSERT INTO acknowledged VALUES('row','before');`);
  } finally {
    database.close();
  }
  await fs.copyFile(baselinePath, candidatePath);
  return { baselinePath, candidatePath, targetPath, assertOwned() {} };
}

it("prepares same-version state through the registered worker entry", async () => {
  const input = await fixture(19);
  const candidate = openNodeSqliteDatabase(input.candidatePath);
  try {
    candidate.prepare("UPDATE acknowledged SET value='candidate' WHERE id='row'").run();
  } finally {
    candidate.close();
  }
  await prepareOpenClawStateRecoveryCopy(input);
  const prepared = openNodeSqliteDatabase(input.targetPath, { readOnly: true });
  try {
    expect(prepared.prepare("SELECT value FROM acknowledged WHERE id='row'").get()).toEqual({
      value: "candidate",
    });
  } finally {
    prepared.close();
  }
});

it("returns the schema-19 reverse refusal from the worker without leaving T", async () => {
  const input = await fixture(17);
  const candidate = openNodeSqliteDatabase(input.candidatePath);
  try {
    candidate.exec("UPDATE schema_meta SET schema_version=19; PRAGMA user_version=19;");
  } finally {
    candidate.close();
  }
  await expect(prepareOpenClawStateRecoveryCopy(input)).rejects.toThrow(
    "permission-bearing schema transition 19 -> 17",
  );
  await expect(fs.access(input.targetPath)).rejects.toThrow();
});

it("does not unlink a replacement target after caller authority is revoked", async () => {
  const input = await fixture(19);
  let assertions = 0;
  await expect(
    prepareOpenClawStateRecoveryCopy({
      ...input,
      assertOwned() {
        assertions += 1;
        if (assertions === 3) {
          fsSync.renameSync(input.targetPath, `${input.targetPath}.owned`);
          fsSync.writeFileSync(input.targetPath, "foreign");
          throw new Error("caller authority revoked");
        }
      },
    }),
  ).rejects.toThrow("caller authority revoked");
  await expect(fs.readFile(input.targetPath, "utf8")).resolves.toBe("foreign");
  await expect(fs.stat(`${input.targetPath}.owned`)).resolves.toMatchObject({
    size: expect.any(Number),
  });
});

it("rejects an agent copy whose stored owner identity changed", async () => {
  const root = await fs.realpath(tempDirs.make("recovery-agent-worker-"));
  const baselinePath = path.join(root, "baseline.sqlite");
  const candidatePath = path.join(root, "candidate.sqlite");
  const baseline = openNodeSqliteDatabase(baselinePath);
  try {
    baseline.exec(`PRAGMA user_version=1;
      CREATE TABLE schema_meta(meta_key TEXT PRIMARY KEY, role TEXT, agent_id TEXT, schema_version INTEGER);
      INSERT INTO schema_meta VALUES('primary','agent','main',1);
      CREATE TABLE acknowledged(id TEXT PRIMARY KEY);`);
  } finally {
    baseline.close();
  }
  await fs.copyFile(baselinePath, candidatePath);
  await expect(
    assertPreparedAgentRecoveryRepresentation({
      baselinePath,
      candidatePath,
      agentId: "main",
      supportedVersion: 1,
      assertOwned() {},
    }),
  ).resolves.toBeUndefined();
  const candidate = openNodeSqliteDatabase(candidatePath);
  try {
    candidate.prepare("UPDATE schema_meta SET agent_id='different'").run();
  } finally {
    candidate.close();
  }
  await expect(
    assertPreparedAgentRecoveryRepresentation({
      baselinePath,
      candidatePath,
      agentId: "main",
      supportedVersion: 1,
      assertOwned() {},
    }),
  ).rejects.toThrow("Only unchanged supported agent representations can be prepared");
});
