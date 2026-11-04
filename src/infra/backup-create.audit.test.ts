import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import * as tar from "tar";
import { expect, it as baseIt, vi } from "vitest";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  inspectDatabase,
  isolateBackupScratch,
  restoreBackup,
  withBackupFixture,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries, listArchiveEntryDetails } from "./backup-create.test-support.js";
import { listDirectoryTreeStrict } from "./directory-walk.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import * as snapshots from "./sqlite-snapshot.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

const auditPath = "logs/config-audit.jsonl";
const rawAuditPath = `${auditPath}.migrated.raw`;
const checkpointCountSql =
  "SELECT COUNT(*) AS count FROM diagnostic_events WHERE scope = 'migration.legacy-audit-raw'";

function auditRecord(key: string, value: string, ts = "2026-07-01T00:00:00.000Z") {
  return {
    ts,
    source: "config-io",
    event: "config.write",
    argv: ["openclaw", "config", "set", key, value],
    execArgv: [],
  };
}

function detectAudit(stateDir: string) {
  return detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true });
}

function migrateAudit(stateDir: string) {
  return migrateLegacyAuditLogs({ detected: detectAudit(stateDir), stateDir });
}

const it = baseIt.extend<{ state: OpenClawTestState }>({
  state: async ({ task: _task }, use) =>
    withBackupFixture({}, async (state) => {
      await isolateBackupScratch(state);
      try {
        await use(state);
      } finally {
        vi.restoreAllMocks();
        closeOpenClawStateDatabase();
      }
    }),
});

function writeAudit(state: OpenClawTestState, record: ReturnType<typeof auditRecord>) {
  return state.writeText(auditPath, `${JSON.stringify(record)}\n`);
}

function archiveEntry(entries: string[], suffix: string) {
  return expectDefined(
    entries.find((entry) => entry.endsWith(suffix)),
    suffix,
  );
}

async function captureBackup(state: OpenClawTestState) {
  const extractDir = state.path("extract");
  await fs.mkdir(extractDir);
  const result = await createBackupArchive({
    output: state.path("backup.tar.gz"),
    includeWorkspace: false,
    nowMs: Date.UTC(2026, 4, 9, 8, 15, 0),
  });
  const entries = await listArchiveEntries(result.archivePath);
  const databaseEntry = archiveEntry(entries, "/state/state/openclaw.sqlite");
  await tar.x({ file: result.archivePath, gzip: true, cwd: extractDir });
  return { result, entries, extractDir, databasePath: path.join(extractDir, databaseEntry) };
}

function expectNoArchivedCheckpoints(databasePath: string) {
  inspectDatabase(databasePath, (database) => {
    expect(database.prepare(checkpointCountSql).get()).toEqual({ count: 0 });
  });
}

it("refuses a legacy audit write lease when preserving source artifacts", async ({ state }) => {
  const record = auditRecord("safe", "retained");
  await writeAudit(state, record);
  const inventory = async () =>
    (await listDirectoryTreeStrict(state.stateDir)).map(({ relativePath }) => relativePath);
  const before = await inventory();
  const output = state.path("backup.tar.gz");
  await expect(
    createBackupArchive({ output, includeWorkspace: false, preserveSourceArtifacts: true }),
  ).rejects.toThrow(/source-artifact-preserving backup.*legacy audit/iu);
  expect(await inventory()).toEqual(before);
  expect(await fs.readFile(state.statePath(auditPath), "utf8")).toBe(`${JSON.stringify(record)}\n`);
  await expect(fs.access(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("replaces legacy audit raw archives with sanitized restorable snapshots", async ({ state }) => {
  const marker = "audit-value-7f3c";
  await state.writeText(rawAuditPath, `${JSON.stringify(auditRecord("token", marker))}\n`);
  const { db } = openOpenClawStateDatabase({ env: state.env });
  db.prepare(
    `INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at, sequence)
         VALUES ('migration.legacy-audit-raw', 'checkpoint', '{}', 1, 1)`,
  ).run();

  const { entries, extractDir, databasePath } = await captureBackup(state);
  const rawEntry = archiveEntry(entries, `/state/${rawAuditPath}`);
  expect(entries.some((entry) => entry.endsWith(".doctor-scrub-restore"))).toBe(false);
  const archivedRaw = await fs.readFile(path.join(extractDir, rawEntry), "utf8");
  expect(archivedRaw).not.toContain(marker);
  expect(JSON.parse(archivedRaw.trim())).toMatchObject({
    argv: ["openclaw", "config", "set", "token", "***"],
  });
  expectNoArchivedCheckpoints(databasePath);
});

it.for(["completed", "quarantined"])(
  "omits %s audit append pads from portable backups",
  async (shape, { state }) => {
    const marker = "quarantined-audit-value-7f3c";
    await writeAudit(state, auditRecord("safe", "value"));
    await migrateAudit(state.stateDir);
    expect(detectAudit(state.stateDir).hasLegacy).toBe(false);
    const sanitizedPath = state.statePath(`${auditPath}.migrated`);
    const sanitizedBytes = await fs.readFile(sanitizedPath);
    const retainedPath = state.statePath(
      shape === "quarantined" ? `${rawAuditPath}.quarantined-backup-fixture` : rawAuditPath,
    );
    if (shape === "quarantined") {
      await fs.writeFile(retainedPath, `${JSON.stringify(auditRecord("token", marker))}\n`);
    }
    const retainedBytes = await fs.readFile(retainedPath);
    if (shape === "quarantined") {
      expect(retainedBytes.toString()).toContain(marker);
    }
    const { db } = openOpenClawStateDatabase({ env: state.env });
    expect(db.prepare(checkpointCountSql).get()).toEqual({ count: 1 });

    const { result, entries, extractDir, databasePath } = await captureBackup(state);
    expect(entries.some((entry) => entry.endsWith(`/state/${rawAuditPath}`))).toBe(false);
    expect(entries.some((entry) => entry.includes(".quarantined-"))).toBe(false);
    const sanitizedEntry = archiveEntry(entries, `/state/${auditPath}.migrated`);
    await expect(fs.readFile(path.join(extractDir, sanitizedEntry))).resolves.toEqual(
      sanitizedBytes,
    );
    for (const entry of await listArchiveEntryDetails(result.archivePath)) {
      if (entry.type === "File") {
        const contents = await fs.readFile(path.join(extractDir, entry.path));
        expect(contents.includes(Buffer.from(marker)), entry.path).toBe(false);
      }
    }
    await expect(fs.readFile(retainedPath)).resolves.toEqual(retainedBytes);
    await expect(fs.readFile(sanitizedPath)).resolves.toEqual(sanitizedBytes);
    expectNoArchivedCheckpoints(databasePath);
  },
);

it.for(["lease-duration overrun", "concurrent audit migration", "identical later append"] as const)(
  "preserves audit ordinals after %s across backup restore",
  async (scenario, { state }) => {
    const record = auditRecord("safe", "preserved-audit-record");
    await writeAudit(state, record);
    if (scenario === "identical later append") {
      await migrateAudit(state.stateDir);
      await fs.appendFile(state.statePath(rawAuditPath), `${JSON.stringify(record)}\n`);
    }
    const originalSnapshot = snapshots.createVerifiedSqliteSnapshot;
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now");
    const snapshot = vi
      .spyOn(snapshots, "createVerifiedSqliteSnapshot")
      .mockImplementationOnce(async (params) => {
        if (scenario === "lease-duration overrun") {
          clock.mockImplementation(() => realNow() + 61_000);
        } else if (scenario === "concurrent audit migration") {
          const migrated = await migrateAudit(state.stateDir);
          expect(migrated.warnings).toEqual([]);
        }
        try {
          return await originalSnapshot(params);
        } finally {
          clock.mockRestore();
        }
      });
    const archive = await createBackupArchive({
      output: state.path("backup.tar.gz"),
      includeWorkspace: false,
    });
    expect(snapshot).toHaveBeenCalled();
    clock.mockRestore();
    snapshot.mockRestore();
    const restored = await restoreBackup(state, archive);
    const stateAsset = expectDefined(
      archive.assets.find((asset) => asset.kind === "state"),
      "restored state asset",
    );
    const restoredStateDir = path.join(restored.targetPath, stateAsset.archivePath);
    if (scenario === "identical later append") {
      expect(detectAudit(restoredStateDir).hasLegacy).toBe(true);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const migrated = await migrateAudit(restoredStateDir);
      expect(migrated.warnings).toEqual([]);
    }
    const records = createSqliteAuditRecordStore({
      scope: CONFIG_AUDIT_SCOPE,
      maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
      env: { ...state.env, OPENCLAW_STATE_DIR: restoredStateDir },
    }).entries();
    const expected = scenario === "identical later append" ? [record, record] : [record];
    expect(new Set(records.map((entry) => entry.key)).size).toBe(expected.length);
    expect(records.map((entry) => entry.value)).toEqual(expected);
  },
);

it("fails closed after bounded retries when the legacy source keeps changing", async ({
  state,
}) => {
  const sourcePath = state.statePath(auditPath);
  const outputPath = state.path("backup.tar.gz");
  await writeAudit(state, auditRecord("safe", "initial"));
  const originalSnapshot = snapshots.createVerifiedSqliteSnapshot;
  let snapshotAttempts = 0;
  vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementation(async (params) => {
    if (params.sourcePath === state.statePath("state/openclaw.sqlite")) {
      snapshotAttempts += 1;
      await fs.appendFile(
        sourcePath,
        `${JSON.stringify(auditRecord("safe", `append-${snapshotAttempts}`, `2026-07-01T00:00:0${snapshotAttempts}.000Z`))}\n`,
      );
    }
    return await originalSnapshot(params);
  });
  await expect(
    createBackupArchive({ output: outputPath, includeWorkspace: false }),
  ).rejects.toThrow(/retry backup after legacy audit migration settles/iu);
  expect(snapshotAttempts).toBe(3);
  await expect(fs.access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
});
