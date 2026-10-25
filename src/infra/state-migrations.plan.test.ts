import { createHash } from "node:crypto";
import fs from "node:fs";
import { endianness } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { planLegacyStateMigrationsReadOnly } from "./state-migrations.doctor.js";
import { captureLegacyStateSnapshotIdentity as captureIdentity } from "./state-migrations.plan.js";
import { createMigrationFixture } from "./state-migrations.shard-fixture.test-support.js";

const tempDirs = createTrackedTempDirs();
const byteOrder = endianness();
const read32 = (buffer: Buffer, offset: number) => buffer[`readUInt32${byteOrder}`](offset);
const write32 = (buffer: Buffer, value: number, offset: number) =>
  buffer[`writeUInt32${byteOrder}`](value, offset);

const sha256 = (value: string | Buffer) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const durableHashes = (databasePath: string) =>
  ["", "-wal"].map((suffix) => sha256(fs.readFileSync(databasePath + suffix)));

function openWal(databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO planner_probe(value) VALUES ('copied-state');
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function copyWal(sourcePath: string, databasePath: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  for (const suffix of ["", "-wal"]) {
    fs.copyFileSync(`${sourcePath}${suffix}`, `${databasePath}${suffix}`);
  }
}

function requireDigest(plan: Awaited<ReturnType<typeof planLegacyStateMigrationsReadOnly>>) {
  const digest = plan.snapshot.stateDigest;
  if (!digest) {
    throw new Error("expected the copied state to have a bound digest");
  }
  return digest;
}

function writeWalIndexHeaderChecksum(header: Buffer): void {
  let first = 0;
  let second = 0;
  for (let offset = 0; offset < 40; offset += 8) {
    first = (first + read32(header, offset) + second) >>> 0;
    second = (second + read32(header, offset + 4) + first) >>> 0;
  }
  write32(header, first, 40);
  write32(header, second, 44);
}

async function makeFixture() {
  return createMigrationFixture(await tempDirs.make("openclaw-migration-plan-identity-"));
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it("defers the Workshop proposal export without touching copied proposal files", async () => {
  const fixture = await makeFixture();
  const draft = path.join(
    fixture.stateDir,
    "skill-workshop/proposals/retained-workshop-20260905-1234567890/PROPOSAL.md",
  );
  fs.mkdirSync(path.dirname(draft), { recursive: true });
  fs.writeFileSync(draft, "---\nname: retained\ndescription: Retained skill\n---\n");
  const before = await captureIdentity(fixture);

  const plan = await fixture.plan();
  const store = { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) };
  const owner = { kind: "owner", id: "core:skill-workshop" };
  expect(plan.steps.find((step) => step.id === "skill-workshop")).toMatchObject({
    phase: "final",
    source: [store, { kind: "path", path: path.join(fixture.stateDir, "skill-workshop") }, owner],
    target: [store, owner],
    requiredness: "conditional",
    outcome: "deferred",
    refusal: { code: "skill-workshop-planning-deferred" },
  });
  expect(await captureIdentity(fixture)).toEqual(before);
  expect(fs.readFileSync(draft, "utf8")).toContain("name: retained");
});

it.each([false, true])("plans without mutating WAL state (missing shm: %s)", async (missing) => {
  const fixture = await makeFixture();
  const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
  const sourcePath = missing ? path.join(fixture.root, "wal-source.sqlite") : databasePath;
  using database = openWal(sourcePath);
  if (missing) {
    copyWal(sourcePath, databasePath);
  }
  const durableBefore = durableHashes(databasePath);
  const shmPath = `${databasePath}-shm`;
  const sharedMemoryBefore = missing ? undefined : sha256(fs.readFileSync(shmPath));
  const plan = await fixture.plan();
  expect(durableHashes(databasePath)).toEqual(durableBefore);
  expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
  if (missing) {
    expect(fs.existsSync(shmPath)).toBe(false);
  } else {
    expect(sha256(fs.readFileSync(shmPath))).toBe(sharedMemoryBefore);
    const stateDigest = requireDigest(plan);
    database.exec("INSERT INTO planner_probe(value) VALUES ('durable-change');");
    const stale = await fixture.plan({ snapshot: { ...plan.snapshot, stateDigest } });
    expect(stale).toMatchObject({
      mutationAllowed: false,
      outcome: "refused",
      refusal: { code: "snapshot-identity-mismatch" },
      steps: [],
    });
    expect(stale.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(stale.snapshot.stateDigest).not.toBe(stateDigest);
  }
});

it("continues binding ordinary copied-state files whose names end in -shm", async () => {
  const fixture = await makeFixture();
  const pairedPath = path.join(fixture.stateDir, "operator-notes");
  const similarlyNamedPath = `${pairedPath}-shm`;
  fs.writeFileSync(pairedPath, "not a SQLite database\n");
  fs.writeFileSync(similarlyNamedPath, "first\n");

  const first = await fixture.plan();
  const stateDigest = requireDigest(first);

  fs.writeFileSync(similarlyNamedPath, "second\n");
  const stale = await fixture.plan({ snapshot: { ...first.snapshot, stateDigest } });
  expect(stale.refusal?.code).toBe("snapshot-identity-mismatch");
});

it("binds fake files and directories at a SQLite shared-memory path", async () => {
  const fixture = await makeFixture();
  const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE planner_probe (id INTEGER PRIMARY KEY);");
  database.close();
  const sharedMemoryPath = `${databasePath}-shm`;

  fs.writeFileSync(sharedMemoryPath, "not a wal-index\n");
  const fileBefore = await captureIdentity(fixture);
  fs.writeFileSync(sharedMemoryPath, "changed durable bytes\n");
  const fileAfter = await captureIdentity(fixture);
  expect(fileAfter.stateDigest).not.toBe(fileBefore.stateDigest);

  fs.rmSync(sharedMemoryPath);
  fs.mkdirSync(sharedMemoryPath);
  const nestedPath = path.join(sharedMemoryPath, "operator-state");
  fs.writeFileSync(nestedPath, "first\n");
  const directoryBefore = await captureIdentity(fixture);
  fs.writeFileSync(nestedPath, "second\n");
  const directoryAfter = await captureIdentity(fixture);
  expect(directoryAfter.stateDigest).not.toBe(directoryBefore.stateDigest);
});

it.each([false, true])("binds wal-index changes (forged structure: %s)", async (forged) => {
  const fixture = await makeFixture();
  const sourcePath = path.join(fixture.root, "wal-index-source.sqlite");
  using source = openWal(sourcePath);
  const databasePath = path.join(fixture.stateDir, "copied.sqlite");
  copyWal(sourcePath, databasePath);
  const index = Buffer.alloc(32_768, 0x5a);
  fs.readFileSync(`${source.location()}-shm`).copy(index, 0, 0, 48);
  if (forged) {
    index.writeUInt8(index.readUInt8(13) ^ 1, 13);
    index[`writeUInt16${byteOrder}`](1, 14);
    write32(index, 0xffff_ffff, 16);
    writeWalIndexHeaderChecksum(index);
  }
  index.copy(index, 48, 0, 48);
  const sharedMemoryPath = `${databasePath}-shm`;
  fs.writeFileSync(sharedMemoryPath, index);
  const before = await captureIdentity(fixture);
  if (forged) {
    write32(index, 0xffff_fffe, 16);
    writeWalIndexHeaderChecksum(index);
    index.copy(index, 48, 0, 48);
  } else {
    index.writeUInt8(index.readUInt8(200) ^ 0xff, 200);
  }
  fs.writeFileSync(sharedMemoryPath, index);
  const after = await captureIdentity(fixture);
  expect(after.stateDigest).not.toBe(before.stateDigest);
  if (forged) {
    index.writeUInt8(index.readUInt8(120) ^ 0xff, 120);
    index.writeUInt8(index.readUInt8(132) ^ 0xff, 132);
    fs.writeFileSync(sharedMemoryPath, index);
    const checkpoint = await captureIdentity(fixture);
    expect(checkpoint.stateDigest).not.toBe(after.stateDigest);
  }
});
