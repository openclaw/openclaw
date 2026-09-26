import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareOpenClawStateRecoveryCopyInProcess } from "./openclaw-state-recovery-preparation.impl.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(version = 19) {
  const root = await fs.realpath(tempDirs.make("recovery-state-copy-"));
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
      INSERT INTO acknowledged VALUES('changed','before'),('deleted','old');`);
    if (version === 19) {
      database.exec(`CREATE TABLE user_profile_identities(
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        authorization_id TEXT,
        authorization_basis_json TEXT,
        PRIMARY KEY(provider, subject)
      ) STRICT;
      INSERT INTO user_profile_identities VALUES(
        'discord', 'owner', 'profile', 'retired-authorization', '{"version":1,"id":"grant"}'
      );`);
    }
  } finally {
    database.close();
  }
  await fs.copyFile(baselinePath, candidatePath);
  return { root, baselinePath, candidatePath, targetPath, assertOwned: () => {} };
}

it("prepares same-version schema 19 from current C without reviving retired authority", async () => {
  const f = await fixture();
  const candidate = openNodeSqliteDatabase(f.candidatePath);
  try {
    candidate.exec(
      `UPDATE acknowledged SET value='newer' WHERE id='changed';
         DELETE FROM acknowledged WHERE id='deleted';
         INSERT INTO acknowledged VALUES('new','acknowledged');
         UPDATE user_profile_identities
           SET authorization_id=NULL,authorization_basis_json=NULL
           WHERE provider='discord' AND subject='owner';`,
    );
  } finally {
    candidate.close();
  }
  const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
  await prepareOpenClawStateRecoveryCopyInProcess(f);
  const prepared = openNodeSqliteDatabase(f.targetPath, { readOnly: true });
  try {
    expect(prepared.prepare("SELECT * FROM acknowledged ORDER BY id").all()).toEqual([
      { id: "changed", value: "newer" },
      { id: "new", value: "acknowledged" },
    ]);
    expect(
      prepared
        .prepare("SELECT authorization_id,authorization_basis_json FROM user_profile_identities")
        .get(),
    ).toEqual({ authorization_id: null, authorization_basis_json: null });
  } finally {
    prepared.close();
  }
  expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
    before,
  );
  await expect(fs.access(f.targetPath)).resolves.toBeUndefined();
});

it("refuses inconsistent candidate schema metadata before inverse migration", async () => {
  const f = await fixture(15);
  const candidate = openNodeSqliteDatabase(f.candidatePath);
  try {
    candidate.exec(`ALTER TABLE acknowledged ADD COLUMN newer TEXT;
      UPDATE schema_meta SET schema_version=19,app_version='candidate' WHERE meta_key='primary';
      PRAGMA user_version=17;`);
  } finally {
    candidate.close();
  }
  const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
  await expect(prepareOpenClawStateRecoveryCopyInProcess(f)).rejects.toThrow(
    "candidate identity does not match published schema 17",
  );
  expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
    before,
  );
  await expect(fs.access(f.targetPath)).rejects.toThrow();
});

it("refuses schema 19 to 17 reverse preparation without lowering permission markers", async () => {
  const f = await fixture(17);
  const candidate = openNodeSqliteDatabase(f.candidatePath);
  try {
    candidate.exec(`ALTER TABLE acknowledged ADD COLUMN authorization_id TEXT;
      UPDATE schema_meta SET schema_version=19,app_version='candidate' WHERE meta_key='primary';
      PRAGMA user_version=19;`);
  } finally {
    candidate.close();
  }
  const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
  await expect(prepareOpenClawStateRecoveryCopyInProcess(f)).rejects.toThrow(
    "permission-bearing schema transition 19 -> 17 requires its owner's recovery contract",
  );
  expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
    before,
  );
  await expect(fs.access(f.targetPath)).rejects.toThrow();
});

it.each(["schema", "owner", "version"] as const)(
  "refuses an unowned %s change without modifying B/C",
  async (change) => {
    const f = await fixture(18);
    const candidate = openNodeSqliteDatabase(f.candidatePath);
    try {
      candidate.exec(
        change === "schema"
          ? "ALTER TABLE acknowledged ADD COLUMN newer TEXT"
          : change === "owner"
            ? "UPDATE schema_meta SET role='agent',agent_id='different'"
            : "PRAGMA user_version=19",
      );
    } finally {
      candidate.close();
    }
    const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
    await expect(prepareOpenClawStateRecoveryCopyInProcess(f)).rejects.toThrow(
      /schema18 changed|candidate identity does not match|permission-bearing schema transition/,
    );
    expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
      before,
    );
    await expect(fs.access(f.targetPath)).rejects.toThrow();
  },
);

it("retains original evidence when native ownership is revoked during copy", async () => {
  const f = await fixture();
  const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
  let assertions = 0;
  await expect(
    prepareOpenClawStateRecoveryCopyInProcess({
      ...f,
      assertOwned: () => {
        if (++assertions > 1) {
          throw new Error("original owner revoked");
        }
      },
    }),
  ).rejects.toThrow("original owner revoked");
  expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
    before,
  );
  await expect(fs.access(f.targetPath)).rejects.toThrow();
  await prepareOpenClawStateRecoveryCopyInProcess({ ...f, assertOwned: () => {} });
  await expect(fs.access(f.targetPath)).resolves.toBeUndefined();
});

it("removes an incomplete exclusive copy without deleting a pre-existing target", async () => {
  const f = await fixture();
  const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
  vi.spyOn(fs, "copyFile").mockImplementationOnce(async (_source, target) => {
    await fs.writeFile(target, "partial");
    throw Object.assign(new Error("copy failed"), { code: "EIO" });
  });
  await expect(prepareOpenClawStateRecoveryCopyInProcess(f)).rejects.toThrow("copy failed");
  await expect(fs.access(f.targetPath)).rejects.toThrow();
  expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
    before,
  );

  await fs.writeFile(f.targetPath, "existing");
  await expect(prepareOpenClawStateRecoveryCopyInProcess(f)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await expect(fs.readFile(f.targetPath, "utf8")).resolves.toBe("existing");
  await expect(
    prepareOpenClawStateRecoveryCopyInProcess({
      ...f,
      candidatePath: path.join(f.root, "missing.sqlite"),
    }),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(f.targetPath, "utf8")).resolves.toBe("existing");
  expect((await fs.readdir(f.root)).filter((name) => name.includes(".copy-"))).toEqual([]);
});

it("removes the prepared target when database finalization fails", async () => {
  const f = await fixture();
  const before = await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)]);
  vi.spyOn(DatabaseSync.prototype, "close").mockImplementationOnce(() => {
    throw new Error("close failed");
  });
  await expect(prepareOpenClawStateRecoveryCopyInProcess(f)).rejects.toThrow(
    "Prepared recovery database close failed: close failed",
  );
  await expect(fs.access(f.targetPath)).rejects.toThrow();
  expect(await Promise.all([fs.readFile(f.baselinePath), fs.readFile(f.candidatePath)])).toEqual(
    before,
  );
});
