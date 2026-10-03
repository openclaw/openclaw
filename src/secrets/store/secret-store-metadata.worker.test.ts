import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  deleteSecretStoreEntry,
  listSecretStoreEntries,
  SecretStoreValidationError,
  writeSecretStoreEntries,
  writeSecretStoreEntry,
  writeSecretStoreEntryWithRollback,
} from "./secret-store.js";

const scope = { kind: "team" } as const;
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "secret-metadata-worker-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("sets, lists, rolls back, and deletes metadata in FIFO order without caller-thread SQL", async () => {
  openOpenClawStateDatabase();
  await closeOpenClawStateDatabaseAsync();
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  const sql = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    vi.spyOn(StatementSync.prototype, "get"),
    vi.spyOn(StatementSync.prototype, "all"),
    vi.spyOn(StatementSync.prototype, "run"),
    vi.spyOn(StatementSync.prototype, "iterate"),
  ];
  const entry = {
    scope,
    name: "WORKER_METADATA_SECRET",
    kind: "secret" as const,
    value: "synthetic-worker-original",
    allowedHosts: ["original.example.test"],
    updatedBy: "fixture",
  };
  const first = writeSecretStoreEntry(entry);
  expect(isSecretValueRegisteredForRedaction(entry.value)).toBe(true);
  const second = writeSecretStoreEntry({
    ...entry,
    value: "synthetic-worker-second",
    allowedHosts: ["second.example.test"],
    updatedBy: "second",
  });
  await Promise.all([first, second]);
  expect(await listSecretStoreEntries({ scope })).toMatchObject([
    { name: entry.name, updatedBy: "second", allowedHosts: ["second.example.test"] },
  ]);

  const staged = await writeSecretStoreEntryWithRollback({
    ...entry,
    kind: "env",
    value: "synthetic-staged-env",
    allowedHosts: undefined,
  });
  const rollingBack = staged.rollback();
  expect(staged.rollback()).toBe(rollingBack);
  expect(await rollingBack).toBe(true);
  const restored = await listSecretStoreEntries({ scope });
  expect(restored).toMatchObject([
    {
      name: entry.name,
      kind: "secret",
      updatedBy: "second",
      allowedHosts: ["second.example.test"],
    },
  ]);
  expect(restored[0]).not.toHaveProperty("valuePreview");

  const superseded = await writeSecretStoreEntryWithRollback({
    ...entry,
    value: "synthetic-worker-superseded",
  });
  await writeSecretStoreEntry({ ...entry, updatedBy: "successor" });
  expect(await superseded.rollback()).toBe(false);
  expect(await listSecretStoreEntries({ scope })).toMatchObject([{ updatedBy: "successor" }]);

  const invalid = writeSecretStoreEntries({
    scope,
    updatedBy: "invalid-batch",
    entries: [
      { name: "MUST_NOT_COMMIT", kind: "env", value: "synthetic-env" },
      { name: "INVALID_SECRET", kind: "secret", value: "" },
    ],
  });
  await expect(invalid).rejects.toBeInstanceOf(SecretStoreValidationError);
  await expect(invalid).rejects.toMatchObject({ code: "SECRET_STORE_VALUE_EMPTY" });
  expect(await listSecretStoreEntries({ scope })).toHaveLength(1);
  await deleteSecretStoreEntry({ scope, name: entry.name });
  expect(await listSecretStoreEntries({ scope })).toEqual([]);
  expect(await listSecretStoreEntries({ scope, includeDeleted: true })).toHaveLength(1);
  await closeOpenClawStateDatabaseAsync();
  for (const spy of sql) {
    expect(spy).not.toHaveBeenCalled();
  }
});

it.each(["transaction", "commit"] as const)(
  "rolls back a batch when current host authority is withdrawn at %s",
  async (withdrawAt) => {
    const context = captureOpenClawStateWorkerContext();
    const stages: string[] = [];
    const operation = runOpenClawStateWorkerOperation(
      context,
      (owner) =>
        owner.execute({
          type: "secrets.write",
          input: {
            scope,
            updatedBy: "revoked-fixture",
            entries: [
              { name: "FIRST_SECRET", kind: "secret", value: "synthetic-first" },
              { name: "SECOND_SECRET", kind: "secret", value: "synthetic-second" },
            ],
            capturePrevious: false,
            now: Date.now(),
          },
        }),
      {
        createAdmission: createSqliteWorkerWriteAdmission(
          (request) => {
            stages.push(request.stage);
            context.admission.assertCurrent();
            if (request.stage === withdrawAt) {
              throw new Error("Synthetic caller authority revoked");
            }
          },
          [context.admission.databasePath],
        ),
      },
    );
    await expect(operation).rejects.toThrow("Synthetic caller authority revoked");
    expect(stages).toEqual(
      withdrawAt === "transaction" ? ["transaction"] : ["transaction", "commit"],
    );
    expect(await listSecretStoreEntries({ scope, includeDeleted: true })).toEqual([]);
  },
);

it("refuses a queued metadata write after its caller is revoked", async () => {
  let current = true;
  const operation = writeSecretStoreEntry({
    scope,
    name: "REVOKED_SECRET",
    kind: "secret",
    value: "synthetic-revoked",
    updatedBy: "fixture",
    assertCurrent: () => {
      if (!current) {
        throw new Error("Synthetic caller authority revoked");
      }
    },
  });
  current = false;
  await expect(operation).rejects.toThrow("Synthetic caller authority revoked");
  expect(await listSecretStoreEntries({ scope, includeDeleted: true })).toEqual([]);
});
