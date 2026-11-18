import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  detectLegacyCommitments,
  migrateLegacyCommitments,
} from "./state-migrations.commitments.js";
import { LegacyMigrationSourceClaim } from "./state-migrations.source-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});
let stateDir: string, source: string, claim: string, env: NodeJS.ProcessEnv;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-commitments-cleanup-");
  source = path.join(stateDir, "commitments", "commitments.json");
  claim = `${source}.doctor-discarding`;
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});
const database = () => openOpenClawStateDatabase({ env }).db;
const rows = (...ids: string[]) => ({ version: 1, commitments: ids.map((id) => ({ id })) });
const detect = (doctorOnlyStateMigrations = true) =>
  detectLegacyCommitments({ stateDir, env, doctorOnlyStateMigrations });
async function migrate(overrides: Partial<Parameters<typeof migrateLegacyCommitments>[0]> = {}) {
  return migrateLegacyCommitments({ detected: await detect(), stateDir, env, ...overrides });
}
async function writeLegacy(value: unknown = rows()) {
  await fsp.mkdir(path.dirname(source), { recursive: true });
  await fsp.writeFile(source, typeof value === "string" ? value : JSON.stringify(value) + "\n");
}
function receipt() {
  return database()
    .prepare("SELECT * FROM migration_sources WHERE migration_kind = 'legacy-commitments-json'")
    .get();
}
function expectPaths(sourceExists: boolean, claimExists: boolean) {
  expect([fs.existsSync(source), fs.existsSync(claim)]).toEqual([sourceExists, claimExists]);
}
function discarded(rowLabel: "1 row" | "2 rows", recreated = false) {
  return {
    changes: [
      `Discarded ${recreated ? "recreated " : ""}retired commitments JSON with ${rowLabel}; no data was imported, archived, or exported.`,
    ],
    warnings: [],
  };
}

it("detects the exact source or deterministic claim only for explicit Doctor repair", async () => {
  await writeLegacy();
  expect((await detect(false)).hasLegacy).toBe(false);
  expect((await detect()).hasLegacy).toBe(true);
  await fsp.rename(source, claim);
  expect((await detect()).hasLegacy).toBe(true);
  await expect(
    migrateLegacyCommitments({ detected: await detect(false), stateDir }),
  ).resolves.toEqual({ changes: [], warnings: [] });
  expect(fs.existsSync(claim)).toBe(true);
});

it("records the destructive decision before deleting recognized rows", async () => {
  await writeLegacy(rows("retired-1", "retired-2"));
  expect(await migrate()).toEqual(discarded("2 rows"));
  expectPaths(false, false);
  expect(await fsp.readdir(path.dirname(source))).toEqual([]);
  expect(
    database().prepare("SELECT name FROM sqlite_schema WHERE name = 'commitments'").get(),
  ).toBeUndefined();
  const recorded = receipt();
  expect(recorded).toMatchObject({
    migration_kind: "legacy-commitments-json",
    target_table: "commitments",
    source_record_count: 2,
    removed_source: 1,
  });
  expect(JSON.parse(String(recorded?.report_json ?? "null"))).toMatchObject({
    decision: "retired-source-discarded",
    importedRecordCount: 0,
    archivedRecordCount: 0,
    exportedRecordCount: 0,
  });
  await writeLegacy(rows("recreated"));
  await expect(migrate()).resolves.toEqual(discarded("1 row", true));
});

it.each([
  ["invalid JSON", "{"],
  ["wrong version", { version: 2, commitments: [] }],
  ["non-array commitments", { version: 1, commitments: {} }],
  ["extra top-level field", { version: 1, commitments: [], archive: true }],
])("leaves %s unchanged with a warning", async (_label, value) => {
  await writeLegacy(value);
  const before = await fsp.readFile(source);
  const result = await migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings[0]).toContain("Failed reading retired commitments JSON");
  await expect(fsp.readFile(source)).resolves.toEqual(before);
  expect(receipt()).toBeUndefined();
});

it("leaves a source changed before cleanup unchanged with a pending receipt", async () => {
  await writeLegacy();
  const verify = vi.spyOn(LegacyMigrationSourceClaim.prototype, "verify");
  verify.mockImplementationOnce(function (this: LegacyMigrationSourceClaim, ...args) {
    verify.mockRestore();
    fs.appendFileSync(source, "\n");
    return this.verify(...args);
  });
  const result = await migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings[0]).toContain("changed");
  expectPaths(true, false);
  expect(receipt()?.removed_source).toBe(0);
});

it.each([false, true])(
  "recovers interrupted cleanup (source already deleted: %s)",
  async (deleted) => {
    await writeLegacy(rows("retired"));
    const verify = vi.spyOn(LegacyMigrationSourceClaim.prototype, "verify");
    verify.mockImplementationOnce(async function (this: LegacyMigrationSourceClaim, ...args) {
      verify.mockRestore();
      await this.verify(...args);
      if (deleted) {
        await fsp.unlink(source);
      }
      throw new Error("simulated cleanup failure");
    });
    const first = await migrate();
    expect(first.changes).toEqual([]);
    expect(first.warnings[0]).toContain("discard was recorded, but cleanup failed");
    expectPaths(!deleted, false);
    expect(receipt()?.removed_source).toBe(0);
    const detected = await detect();
    expect(detected.hasLegacy).toBe(true);
    expect(await migrate({ detected })).toEqual(
      deleted
        ? { changes: ["Finalized the retired commitments JSON discard receipt."], warnings: [] }
        : discarded("1 row"),
    );
    expectPaths(false, false);
    expect(receipt()?.removed_source).toBe(1);
    expect((await detect()).hasLegacy).toBe(false);
    await expect(migrate()).resolves.toEqual({ changes: [], warnings: [] });
  },
);

it("leaves conflicting source and interrupted claim bytes unchanged", async () => {
  await writeLegacy(rows("claim"));
  await fsp.rename(source, claim);
  await writeLegacy(rows("replacement"));
  const result = await migrate();
  expect(result.changes).toEqual([]);
  expect(result.warnings[0]).toContain("conflicts with its interrupted Doctor claim");
  expectPaths(true, true);
  expect(receipt()).toBeUndefined();
});
