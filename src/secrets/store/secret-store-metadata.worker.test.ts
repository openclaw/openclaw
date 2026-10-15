import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { isSecretValueRegisteredForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
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
import { resolveSecretRefString } from "../resolve.js";
import { resolveSecretSentinel } from "../sentinel.js";
import {
  consumeGitHubSetupHandoff,
  deleteSecretStoreEntry,
  listSecretStoreEntries,
  readSecretStoreExecEnvironment,
  readSelectedSecretStoreEntries,
  readSecretStoreValue,
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

it("reads exec and SecretRef values without caller-thread SQL and registers host redaction", async () => {
  await writeSecretStoreEntries({
    scope,
    updatedBy: "fixture",
    entries: [
      { name: "WORKER_READ_SECRET", kind: "secret", value: "synthetic-worker-read" },
      { name: "WORKER_READ_ENV", kind: "env", value: "synthetic-env" },
      {
        name: "github-setup-11111111111111111111111111111111",
        kind: "secret",
        value: "synthetic-handoff",
      },
    ],
  });
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
  resetSecretRedactionRegistryForTest();
  const value = await resolveSecretRefString(
    { source: "store", provider: "default", id: "WORKER_READ_SECRET" },
    { config: {}, env: state.env },
  );
  expect(isSecretValueRegisteredForRedaction(value)).toBe(true);
  expect(value).toBe("synthetic-worker-read");
  resetSecretRedactionRegistryForTest();
  const environment = await readSecretStoreExecEnvironment({ includeSecretSentinels: true });
  expect(isSecretValueRegisteredForRedaction("synthetic-worker-read")).toBe(true);
  expect(environment.env).toEqual({ WORKER_READ_ENV: "synthetic-env" });
  expect(resolveSecretSentinel(environment.secretSentinels?.WORKER_READ_SECRET ?? "")).toBe(value);
  resetSecretRedactionRegistryForTest();
  expect(
    await consumeGitHubSetupHandoff({ name: "github-setup-11111111111111111111111111111111" }),
  ).toBe("synthetic-handoff");
  expect(isSecretValueRegisteredForRedaction("synthetic-handoff")).toBe(true);
  await closeOpenClawStateDatabaseAsync();
  for (const spy of sql) {
    expect(spy).not.toHaveBeenCalled();
  }
});

it("pins the physical read source before yielding and refuses revoked disclosure", async () => {
  await writeSecretStoreEntry({
    scope,
    name: "PINNED_SECRET",
    kind: "secret",
    value: "synthetic-pinned-read",
    updatedBy: "fixture",
  });
  const env = { ...state.env };
  const reading = readSecretStoreValue({ scope, name: "PINNED_SECRET", database: { env } });
  env.OPENCLAW_STATE_DIR = state.statePath("replacement");
  expect(await reading).toEqual({ ok: true, value: "synthetic-pinned-read" });

  let current = true;
  const revoked = readSecretStoreValue({
    scope,
    name: "PINNED_SECRET",
    assertCurrent: () => {
      if (!current) {
        throw new Error("Synthetic read authority revoked");
      }
    },
  });
  current = false;
  expect(await revoked).toMatchObject({
    ok: false,
    error: {
      code: "SECRET_STORE_UNAVAILABLE",
      cause: new Error("Synthetic read authority revoked"),
    },
  });
});

it("loads only named protected rows with their host policy in a worker snapshot", async () => {
  await writeSecretStoreEntries({
    scope,
    updatedBy: "fixture",
    entries: [
      {
        name: "SELECTED_ONE",
        kind: "secret",
        value: "synthetic-selected-one",
        allowedHosts: ["one.example.test"],
      },
      {
        name: "SELECTED_TWO",
        kind: "secret",
        value: "synthetic-selected-two",
        allowedHosts: ["two.example.test"],
      },
      { name: "UNRELATED_SECRET", kind: "secret", value: "synthetic-unrelated" },
      { name: "READABLE_ENV", kind: "env", value: "synthetic-readable" },
      { name: "DELETED_SECRET", kind: "secret", value: "synthetic-deleted" },
    ],
  });
  await deleteSecretStoreEntry({ scope, name: "DELETED_SECRET" });
  await closeOpenClawStateDatabaseAsync();
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  const sql = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    vi.spyOn(StatementSync.prototype, "get"),
    vi.spyOn(StatementSync.prototype, "all"),
    vi.spyOn(StatementSync.prototype, "iterate"),
  ];
  resetSecretRedactionRegistryForTest();
  expect(
    await readSelectedSecretStoreEntries({
      names: [
        "SELECTED_TWO",
        "READABLE_ENV",
        "SELECTED_ONE",
        "DELETED_SECRET",
        "MISSING_SECRET",
        "SELECTED_ONE",
      ],
    }),
  ).toEqual([
    { name: "SELECTED_ONE", value: "synthetic-selected-one", allowedHosts: ["one.example.test"] },
    { name: "SELECTED_TWO", value: "synthetic-selected-two", allowedHosts: ["two.example.test"] },
  ]);
  expect(isSecretValueRegisteredForRedaction("synthetic-selected-one")).toBe(true);
  expect(isSecretValueRegisteredForRedaction("synthetic-unrelated")).toBe(false);
  expect(isSecretValueRegisteredForRedaction("synthetic-deleted")).toBe(false);
  await expect(
    readSelectedSecretStoreEntries({
      names: ["SELECTED_ONE"],
      assertCurrent: () => {
        throw new Error("selected authority revoked");
      },
    }),
  ).rejects.toThrow("selected authority revoked");
  await closeOpenClawStateDatabaseAsync();
  for (const spy of sql) {
    expect(spy).not.toHaveBeenCalled();
  }
});

it("rejects oversized value and exec replies without returning partial secrets", async () => {
  const { db } = openOpenClawStateDatabase();
  const insert = db.prepare(
    "INSERT INTO secret_store_entries (scope_kind, scope_id, name, kind, value, created_at_ms, updated_at_ms) VALUES ('team', '', ?, 'env', ?, 1, 1)",
  );
  const value = "synthetic-budget-fixture".padEnd(64 * 1024, "x");
  db.exec("BEGIN");
  try {
    for (let index = 0; index < 512; index++) {
      insert.run(`BUDGET_${index}`, value);
    }
    // An older/corrupt writer can leave a value above the current write limit.
    insert.run("OVERSIZED_VALUE", `${value}x`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  await closeOpenClawStateDatabaseAsync();
  expect(await readSecretStoreValue({ scope, name: "OVERSIZED_VALUE" })).toMatchObject({
    ok: false,
    error: { code: "SECRET_STORE_UNAVAILABLE" },
  });
  await expect(readSecretStoreExecEnvironment({ includeSecretSentinels: false })).rejects.toThrow(
    "32 MiB read limit",
  );
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
