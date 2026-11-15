import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expectBytesEqual } from "../../test/helpers/file-snapshots.js";
import type { RetainedPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { SqliteSnapshotCapacityError } from "../infra/sqlite-snapshot-capacity-error.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import { DoctorStateMigrationRefusalError } from "../infra/state-migrations.messages.js";
import { buildLegacyStateMigrationPreludeSteps } from "../infra/state-migrations.prelude.js";
import { runLegacyStateMigrationSteps } from "../infra/state-migrations.steps.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { repairLegacySessionEntryStates } from "./doctor-session-delivery-state.js";
import {
  type DoctorSqliteMaintenanceAuthority,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

// An update's activation Doctor that cannot stage its disposable read-only snapshot.
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await state?.cleanup();
});

function seedLegacyEntry() {
  const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  const entry = { sessionId: "session-legacy", updatedAt: 42, pendingFinalDelivery: true };
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at, entry_valid) VALUES (?, ?, ?, ?, 1)",
    )
    .run("agent:main:legacy", entry.sessionId, JSON.stringify(entry), entry.updatedAt);
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at) VALUES (?, ?, 'conversation', 42, 42)",
    )
    .run(entry.sessionId, "agent:main:legacy");
  // Unapplied WAL frames need a private snapshot; a drained family is read in place.
  const sidecars = ["-wal", "-shm"].map((suffix) => {
    const file = `${database.path}${suffix}`;
    return { file, bytes: fs.readFileSync(file) };
  });
  expect(sidecars[0]!.bytes.length).toBeGreaterThan(0);
  closeOpenClawAgentDatabasesForTest();
  for (const { file, bytes } of sidecars) {
    fs.writeFileSync(file, bytes);
  }
  return database.path;
}

const repairEntryStates = (authority: DoctorSqliteMaintenanceAuthority) =>
  repairLegacySessionEntryStates({ apply: true, cfg: {}, env: state.env, authority });

/** Run Doctor work inside the update's migration capture, as activation does. */
async function runDuringCapture<T>(
  databasePath: string,
  run: (authority: DoctorSqliteMaintenanceAuthority) => Promise<T>,
) {
  const generations = readUpdateDatabaseGenerations([databasePath]);
  const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
    env: state.env,
    signal: new AbortController().signal,
    warn: () => {},
  })!;
  return await withDoctorSqliteMaintenanceLock({
    env: state.env,
    operation: "session entry capacity test",
    run: async (authority) => {
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => authority.assertCurrent(),
      });
      try {
        await capture.admit();
        const outcome = await scope
          .run(() => capture.run(() => run(authority)))
          .then(
            (report) => ({ report, error: undefined }),
            (error: unknown) => ({ report: undefined, error }),
          );
        await capture.settle();
        return { ...outcome, receipt: capture.receipt };
      } finally {
        await scope.close();
      }
    },
  });
}

function failSnapshotStaging(failure: Error) {
  return vi.spyOn(snapshotSource, "startSqliteReadOnlyLocationAsync").mockImplementation(() => {
    const preparation = createRetainedOperation<RetainedPreparedSqliteReadOnlyLocation>(() => {});
    preparation.reject(failure);
    const closed = createRetainedOperation<void>(() => {});
    closed.resolve();
    return { ...preparation.operation, startClose: () => closed.operation };
  });
}

const capacityFailure = () =>
  new SqliteSnapshotCapacityError(
    "SQLite read-only worker failed while creating its private snapshot: SQLite read-only snapshot needs 21 GiB",
  );

it("defers an update's entry-state inspection when snapshot space runs out", async () => {
  const databasePath = seedLegacyEntry();
  const original = fs.readFileSync(databasePath);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  const staging = failSnapshotStaging(capacityFailure());

  const outcome = await runDuringCapture(databasePath, repairEntryStates);

  expect(staging).toHaveBeenCalled();
  expect(outcome.error).toBeUndefined();
  expect(outcome.report).toMatchObject({ found: 0, repaired: 0 });
  expect(outcome.report?.warnings).toEqual([
    expect.stringMatching(
      /^Session entry state inspection deferred for agent main: .*needs 21 GiB.*openclaw.* doctor --fix/su,
    ),
  ]);
  expect(outcome.receipt).toMatchObject({ unchanged: true });
  expectBytesEqual(fs.readFileSync(databasePath), original, "deferred database");
});

it.each([
  { case: "outside an update", update: "0", failure: capacityFailure },
  { case: "for a non-capacity failure", update: "1", failure: () => new Error("disk I/O error") },
])("keeps the entry-state inspection blocking $case", async ({ update, failure }) => {
  const databasePath = seedLegacyEntry();
  const original = fs.readFileSync(databasePath);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", update);
  const injected = failure();
  failSnapshotStaging(injected);

  const outcome = await runDuringCapture(databasePath, repairEntryStates);

  expect(outcome.error).toBeInstanceOf(DoctorStateMigrationRefusalError);
  expect(outcome.error).toMatchObject({ message: expect.stringContaining(injected.message) });
  expect(outcome.receipt).toMatchObject({ unchanged: true });
  expectBytesEqual(fs.readFileSync(databasePath), original, "refused database");
});

it("records the deferred inspection and continues the activation migration", async () => {
  const databasePath = seedLegacyEntry();
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  failSnapshotStaging(capacityFailure());
  const steps = buildLegacyStateMigrationPreludeSteps({
    mode: "doctor",
    invocationPurpose: "doctor",
    config: {},
    configPath: path.join(state.stateDir, "openclaw.json"),
    configIncludedPaths: [],
    stateDir: state.stateDir,
    env: state.env,
    homedir: () => state.stateDir,
    agentDatabaseTargets: [{ agentId: "main", path: databasePath }],
    pluginSessionStoreAgentIds: [],
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  }).filter(({ id }) =>
    [
      "session-entry-state-preparation",
      "media-persistence",
      "session-entry-state",
      "cold-navigation",
    ].includes(id),
  );

  // An open read transaction keeps WAL frames in place, so the scan still needs a private snapshot.
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM session_nodes").get();
  const outcome = await runDuringCapture(databasePath, () =>
    runLegacyStateMigrationSteps(steps),
  ).finally(() => reader.close());

  expect(outcome.error).toBeUndefined();
  expect(outcome.report?.receipts.map((step) => [step.id, step.outcome])).toEqual([
    ["session-entry-state-preparation", "skipped"],
    ["media-persistence", "skipped"],
    ["session-entry-state", "deferred"],
    ["cold-navigation", "skipped"],
  ]);
  expect(outcome.receipt).toMatchObject({ unchanged: true });
});
