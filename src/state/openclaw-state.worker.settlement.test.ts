import { copyFileSync, existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./openclaw-state.worker.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-worker-settlement-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("closes an existing-only actor without recreating its missing database", async () => {
  const databasePath = openOpenClawStateDatabase().path;
  await closeOpenClawStateDatabaseAsync();
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    openExistingSqliteWorkerBackend(undefined, {
      databasePath,
      existingIdentity: context.admission.identity.key,
    }),
  );
  unlinkSync(databasePath);
  try {
    expect(existsSync(context.admission.databasePath)).toBe(false);
  } finally {
    await backend.close();
  }
  expect(existsSync(context.admission.databasePath)).toBe(false);
});

it.each(["subset-only", "native-closed"] as const)(
  "settles a retained update writer with a %s backend",
  async (kind) => {
    const run = createUpdateRun({ trigger: "cli" });
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateWorkerContext();
    const databasePath = context.admission.databasePath;
    const backend = runWithSqliteWorkerStateContext(context, () =>
      kind === "native-closed"
        ? createSqliteWorkerBackend(undefined, { databasePath })
        : openExistingSqliteWorkerBackend(undefined, {
            databasePath,
            existingIdentity: context.admission.identity.key,
          }),
    );
    const native = kind === "native-closed" ? openOpenClawStateDatabase() : undefined;
    const admission = vi
      .spyOn(operationAdmission, "requestSqliteWorkerOperationAdmission")
      .mockImplementation(() => {});
    try {
      await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("updateRuns.recordStep");
      const recorded = runWithSqliteWorkerStateContext(context, () =>
        backend.execute({
          type: "updateRuns.recordStep",
          input: {
            runId: run.runId,
            step: { step: "candidate-state-snapshot", status: "in_progress" },
            redactionFacts: { effectiveHome: state.home },
          },
        }),
      );
      expect(recorded).toMatchObject({
        kind: "recorded",
        record: {
          steps: expect.arrayContaining([
            expect.objectContaining({ step: "candidate-state-snapshot", status: "in_progress" }),
          ]),
        },
      });
      native?.db.close();
      expect(() => backend.assertSettled!()).not.toThrow();
    } finally {
      admission.mockRestore();
      await backend.close();
    }
  },
);

it.each(["removed", "replaced"] as const)(
  "refuses a lazy actor's %s original locator even while a hardlink survives",
  async (kind) => {
    const databasePath = openOpenClawStateDatabase().path;
    await closeOpenClawStateDatabaseAsync();
    const alias = state.statePath("retained.sqlite");
    linkSync(databasePath, alias);
    const original = readFileSync(alias);
    const context = captureOpenClawStateWorkerContext();
    const backend = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, {
        databasePath,
        existingIdentity: context.admission.identity.key,
      }),
    );
    unlinkSync(databasePath);
    if (kind === "replaced") {
      copyFileSync(alias, databasePath);
    }
    try {
      for (const command of [
        {
          type: "stateLease.verify",
          input: { identity: { scope: "fixture", key: "lease", owner: "owner" } },
        },
        {
          type: "stateLease.acquire",
          input: {
            identity: { scope: "fixture", key: "lease", owner: "owner" },
            leaseMs: 300_000,
            operationLabel: "fixture",
            schemaPolicy: "existing",
          },
        },
        { type: "deviceIdentity.load", input: { identityKey: "fixture" } },
      ] as const) {
        expect(() =>
          runWithSqliteWorkerStateContext(context, () => backend.execute(command)),
        ).toThrow(kind === "removed" ? /ENOENT/ : /identity changed/);
        expect(readFileSync(alias)).toEqual(original);
        if (kind === "removed") {
          expect(existsSync(databasePath)).toBe(false);
        } else {
          expect(readFileSync(databasePath)).toEqual(original);
        }
      }
    } finally {
      await backend.close();
    }
  },
);

it("rejects leaked readers and unfinished transactions through the same actor settlement hook", async () => {
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
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
    await backend.close();
  }
});
