import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../test/helpers/file-snapshots.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionEntryStates } from "./doctor-session-delivery-state.js";
import {
  seedSessionEntry,
  withSessionEntryMaintenance,
} from "./doctor-session-entry-state.test-support.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";
import * as entryRepairs from "./doctor/shared/session-entry-rewrite.js";

// Doctor inspections under an update's migration capture, while it holds schema custody.
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

const withMaintenance = <T>(run: (authority: DoctorSqliteMaintenanceAuthority) => Promise<T> | T) =>
  withSessionEntryMaintenance(state.env, run);
const repair = (apply: boolean, authority?: DoctorSqliteMaintenanceAuthority) =>
  repairLegacySessionEntryStates({ apply, cfg: {}, env: state.env, authority });
const seedEntry = (key: string, fields: Record<string, unknown>) =>
  seedSessionEntry(state.env, key, fields);

it("closes a captured session inspection reader before removing its private snapshot", async () => {
  const legacy = seedEntry("captured-inspection", { pendingFinalDelivery: true });
  // Unapplied WAL frames keep the private copy: only a drained family is read in place.
  const sidecars = ["-wal", "-shm"].map((suffix) => {
    const file = `${legacy.databasePath}${suffix}`;
    return { file, bytes: fs.readFileSync(file) };
  });
  expect(sidecars[0]!.bytes.length).toBeGreaterThan(0);
  closeOpenClawAgentDatabasesForTest();
  for (const { file, bytes } of sidecars) {
    fs.writeFileSync(file, bytes);
  }
  const originalBytes = fs.readFileSync(legacy.databasePath);
  const generations = readUpdateDatabaseGenerations([legacy.databasePath]);
  const warnings: string[] = [];
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env: state.env,
    signal: new AbortController().signal,
    warn: (message) => warnings.push(message),
  })!;
  let snapshot:
    | Awaited<ReturnType<typeof snapshotSource.startSqliteReadOnlyLocationAsync>["result"]>
    | undefined;
  let reader: DatabaseSync | undefined;
  const openAtCleanup: boolean[] = [];
  const prepare = snapshotSource.startSqliteReadOnlyLocationAsync;
  vi.spyOn(snapshotSource, "startSqliteReadOnlyLocationAsync").mockImplementation((...args) => {
    const preparation = prepare(...args);
    return {
      ...preparation,
      result: preparation.result.then((prepared) => {
        snapshot = prepared;
        return prepared;
      }),
      startClose() {
        openAtCleanup.push(reader?.isOpen ?? true);
        return preparation.startClose();
      },
    };
  });
  const open = nodeSqlite.openNodeSqliteDatabase;
  vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    if (args[0] === snapshot?.location) {
      reader = database;
    }
    return database;
  });
  await withMaintenance(async (authority) => {
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => authority.assertCurrent(),
    });
    try {
      await capture.admit();
      const result = await scope.run(() => capture.run(() => repair(false, authority)));
      expect(result).toMatchObject({ found: 1, repaired: 0, scannedStores: 1 });
      expect(reader).toBeDefined();
      expect(openAtCleanup).toEqual([false]);
      expect(fs.existsSync(snapshot!.cleanupRoot!)).toBe(false);
      await capture.settle();
      expect(capture.receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
      expect(warnings).toEqual([]);
      expectBytesEqual(fs.readFileSync(legacy.databasePath), originalBytes, "inspected database");
    } finally {
      await scope.close();
      await snapshot?.cleanupAsync();
    }
  });
});

it("inspects a drained captured database in place without a private copy", async () => {
  const legacy = seedEntry("captured-drained", { pendingFinalDelivery: true });
  closeOpenClawAgentDatabasesForTest();
  const directory = path.dirname(legacy.databasePath);
  expect(fs.existsSync(`${legacy.databasePath}-journal`)).toBe(false);
  expect(fs.statSync(`${legacy.databasePath}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
  const originalBytes = fs.readFileSync(legacy.databasePath);
  const originalEntries = fs.readdirSync(directory).toSorted();
  const generations = readUpdateDatabaseGenerations([legacy.databasePath]);
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env: state.env,
    signal: new AbortController().signal,
    warn: () => {},
  })!;
  // A private image costs the whole family, which a full disk during activation cannot spare.
  const privateCopy = vi.spyOn(snapshotSource, "startSqliteReadOnlyLocationAsync");
  await withMaintenance(async (authority) => {
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => authority.assertCurrent(),
    });
    try {
      await capture.admit();
      const result = await scope.run(() => capture.run(() => repair(false, authority)));
      expect(result).toMatchObject({ found: 1, repaired: 0, scannedStores: 1 });
      await capture.settle();
      expect(capture.receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
    } finally {
      await scope.close();
    }
  });
  expect(privateCopy).not.toHaveBeenCalled();
  expectBytesEqual(fs.readFileSync(legacy.databasePath), originalBytes, "inspected database");
  expect(fs.readdirSync(directory).toSorted()).toEqual(originalEntries);
});

it("refuses an in-place captured inspection when the source changes during the read", async () => {
  const legacy = seedEntry("captured-changed", { pendingFinalDelivery: true });
  closeOpenClawAgentDatabasesForTest();
  const generations = readUpdateDatabaseGenerations([legacy.databasePath]);
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env: state.env,
    signal: new AbortController().signal,
    warn: () => {},
  })!;
  const expectedIdentity = readDatabasePathIdentitySync(legacy.databasePath);
  await withMaintenance(async (authority) => {
    const scope = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => authority.assertCurrent(),
    });
    try {
      await capture.admit();
      // An immutable open cannot see a writer, so the changed file must invalidate the read.
      const changed = new Date(Date.now() + 60_000);
      await expect(
        scope.run(() =>
          capture.run(() =>
            entryRepairs.scanDoctorSessionEntryRecords(
              legacy.scope,
              () => fs.utimesSync(legacy.databasePath, changed, changed),
              expectedIdentity,
            ),
          ),
        ),
      ).rejects.toThrow(/source changed during in-place inspection/);
    } finally {
      await scope.close();
    }
  });
});
