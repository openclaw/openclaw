import { copyFileSync, existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { isSqliteDatabaseAdmissionFactCurrent } from "../infra/sqlite-database-admission-record.js";
import {
  captureSqliteDatabaseAdmissions,
  withSqliteDatabaseAdmissionExchange,
} from "../infra/sqlite-database-admission.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state-row.js";
import { writeConfigMachineState } from "./config-machine-state-write.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import * as worker from "./openclaw-state.worker.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let activeBackend: ReturnType<typeof worker.createSqliteWorkerBackend> | undefined;
async function openBackend(kind: "existing" | "native-closed" | "native" = "existing") {
  if (kind !== "native") {
    openOpenClawStateDatabase();
    await closeOpenClawStateDatabaseAsync();
  }
  const context = captureOpenClawStateWorkerContext();
  const run = <T>(operation: () => T) => runWithSqliteWorkerStateContext(context, operation);
  const { databasePath, identity } = context.admission;
  const options = { databasePath, existingIdentity: identity.key };
  const create =
    kind === "existing" ? worker.openExistingSqliteWorkerBackend : worker.createSqliteWorkerBackend;
  const backend = run(() => create(undefined, options));
  activeBackend = backend;
  return { run, backend, databasePath };
}
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-worker-settlement-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await activeBackend?.close();
  activeBackend = undefined;
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("publishes a single machine-state write without a transaction envelope", async () => {
  const key = "tts.prefsPath";
  writeConfigMachineState(key, "original");
  const { run, backend, databasePath } = await openBackend("native");
  const { db } = openOpenClawStateDatabase();
  using reader = new DatabaseSync(databasePath, { readOnly: true });
  expect(readConfigMachineStateRowInDatabase(db, key)?.value_json).toBe('"original"');
  await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("machineState.write");
  const execute = vi.spyOn(db, "exec");
  vi.spyOn(Date, "now").mockReturnValue(12_345);
  const writtenAt = run(() =>
    backend.execute({
      type: "machineState.write",
      input: { key: ` ${key} `, value: "updated" },
    }),
  );
  const expected = { value_json: '"updated"', updated_at_ms: 12_345 };
  expect(writtenAt).toBe(expected.updated_at_ms);
  expect(readConfigMachineStateRowInDatabase(db, key)).toEqual(expected);
  expect(
    reader
      .prepare("SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?")
      .get(key),
  ).toEqual(expected);
  expect(() => backend.assertSettled!()).not.toThrow();
  expect(
    execute.mock.calls.filter(([sql]) =>
      /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql),
    ),
  ).toEqual([]);
});

it("keeps a committed machine-state write successful when admission exchange fails", async () => {
  const key = "tts.prefsPath";
  writeConfigMachineState(key, "original");
  const { run, backend, databasePath } = await openBackend("native");
  const { db } = openOpenClawStateDatabase();
  using reader = new DatabaseSync(databasePath, { readOnly: true });
  expect(readConfigMachineStateRowInDatabase(db, key)?.value_json).toBe('"original"');
  await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("machineState.write");
  const [before] = captureSqliteDatabaseAdmissions(undefined, { location: databasePath });
  const previous = before!.facts.get("state.tts-prefs-path")!;
  expect(isSqliteDatabaseAdmissionFactCurrent(before!, previous)).toBe(true);
  const readPersistedRow = () =>
    reader
      .prepare("SELECT value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?")
      .get(key);
  const rowsAtExchange: unknown[] = [];
  const oldReceiptAtExchange: boolean[] = [];
  vi.spyOn(Date, "now").mockReturnValue(12_345);
  const writtenAt = withSqliteDatabaseAdmissionExchange(
    (admissions) => {
      const next = admissions
        .find((record) => record.identity === before!.identity)
        ?.facts.get("state.tts-prefs-path");
      if (next && next.publication !== previous.publication) {
        rowsAtExchange.push(readPersistedRow());
        oldReceiptAtExchange.push(isSqliteDatabaseAdmissionFactCurrent(before!, previous));
        throw new Error("synthetic admission exchange failure");
      }
      return [];
    },
    () =>
      run(() => backend.execute({ type: "machineState.write", input: { key, value: "updated" } })),
  );
  const expected = { value_json: '"updated"', updated_at_ms: 12_345 };
  expect(writtenAt).toBe(expected.updated_at_ms);
  expect(rowsAtExchange).toEqual([expected]);
  expect(oldReceiptAtExchange).toEqual([false]);
  expect(readPersistedRow()).toEqual(expected);
  expect(readConfigMachineStateRowInDatabase(db, key)).toEqual(expected);
  expect(() => backend.assertSettled!()).not.toThrow();
});

it("closes an existing-only actor without recreating its missing database", async () => {
  const { backend, databasePath } = await openBackend();
  unlinkSync(databasePath);
  expect(existsSync(databasePath)).toBe(false);
  await backend.close();
  activeBackend = undefined;
  expect(existsSync(databasePath)).toBe(false);
});

it.each(["existing", "native-closed"] as const)("settles the %s update writer", async (kind) => {
  const run = createUpdateRun({ trigger: "cli" });
  const { run: inContext, backend } = await openBackend(kind);
  const native = kind === "native-closed" ? openOpenClawStateDatabase() : undefined;
  vi.spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission").mockImplementation(
    () => {},
  );
  await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("updateRuns.recordStep");
  const recorded = inContext(() =>
    backend.execute({
      type: "updateRuns.recordStep",
      input: {
        runId: run.runId,
        step: { step: "candidate-state-snapshot", status: "in_progress" },
        redactionFacts: { effectiveHome: state.home },
      },
    }),
  );
  expect(recorded).toHaveProperty("kind", "recorded");
  expect(recorded).toHaveProperty(
    "record.steps",
    expect.arrayContaining([
      expect.objectContaining({ step: "candidate-state-snapshot", status: "in_progress" }),
    ]),
  );
  native?.db.close();
  expect(() => backend.assertSettled!()).not.toThrow();
});

it.each(["removed", "replaced"] as const)("refuses a %s locator with a hardlink", async (kind) => {
  const { run, backend, databasePath } = await openBackend();
  const alias = state.statePath("retained.sqlite");
  linkSync(databasePath, alias);
  const original = readFileSync(alias);
  unlinkSync(databasePath);
  if (kind === "replaced") {
    copyFileSync(alias, databasePath);
  }
  const identity = { scope: "fixture", key: "lease", owner: "owner" };
  for (const command of [
    { type: "stateLease.verify", input: { identity } },
    {
      type: "stateLease.acquire",
      input: { identity, leaseMs: 300_000, operationLabel: "lease", schemaPolicy: "existing" },
    },
    { type: "machineState.write", input: { key: "fixture", value: "synthetic" } },
  ] as const) {
    await backend[SQLITE_WORKER_PREPARE_COMMAND]?.(command.type);
    expect(() => run(() => backend.execute(command))).toThrow(
      kind === "removed" ? /ENOENT/ : /identity changed/,
    );
    expect([
      readFileSync(alias),
      kind === "removed" ? existsSync(databasePath) : readFileSync(databasePath),
    ]).toEqual([original, kind === "removed" ? false : original]);
  }
});

it("rejects leaked readers and unfinished transactions through the same actor settlement hook", async () => {
  const { backend } = await openBackend("native");
  const { db } = openOpenClawStateDatabase();
  const query = getNodeSqliteKysely<{ schema_meta: { schema_version: number } }>(db)
    .selectFrom("schema_meta")
    .select("schema_version");
  const reader = iterateSqliteQuerySync(db, query);
  try {
    expect(() => backend.assertSettled!()).not.toThrow();
    expect(reader.next().done).toBe(false);
    expect(db.isTransaction).toBe(false);
    expect(() => backend.assertSettled!()).toThrow("active SQLite reader");
    reader.return?.();
    expect(() => backend.assertSettled!()).not.toThrow();
    db.exec("BEGIN");
    expect(() => backend.assertSettled!()).toThrow("unsettled transaction");
    db.exec("ROLLBACK");
    expect(() => backend.assertSettled!()).not.toThrow();
  } finally {
    reader.return?.();
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
  }
});
