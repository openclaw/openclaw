import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import { isSecretValueRegisteredForRedaction as isRegistered } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawStateDatabaseAsync as closeDatabase,
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
  readSecretStoreExecEnvironment as readExec,
  readSelectedSecretStoreEntries as readSelected,
  readSecretStoreValue as readValue,
  SecretStoreValidationError,
  type SecretStoreWriteEntry,
  type SecretStoreWriteParams,
  writeSecretStoreEntries,
  writeSecretStoreEntry,
  writeSecretStoreEntryWithRollback as writeWithRollback,
} from "./secret-store.js";

const scope = { kind: "team" } as const;
let state: OpenClawTestState;

function entry(name: string, value: string, options: Partial<SecretStoreWriteEntry> = {}) {
  return { name, value, kind: "secret" as const, ...options };
}

function write(name: string, value: string, options: Partial<SecretStoreWriteParams> = {}) {
  return writeSecretStoreEntry({ scope, updatedBy: "fixture", ...entry(name, value), ...options });
}

function writeEntries(entries: SecretStoreWriteEntry[], updatedBy = "fixture") {
  return writeSecretStoreEntries({ scope, updatedBy, entries });
}

function list(includeDeleted = false) {
  return listSecretStoreEntries({ scope, includeDeleted });
}

function spyOnCallerSql(includeRun = true) {
  const { DatabaseSync, StatementSync } = requireNodeSqlite();
  const spies = [
    vi.spyOn(DatabaseSync.prototype, "prepare"),
    vi.spyOn(DatabaseSync.prototype, "exec"),
    vi.spyOn(StatementSync.prototype, "get"),
    vi.spyOn(StatementSync.prototype, "all"),
    vi.spyOn(StatementSync.prototype, "iterate"),
    ...(includeRun ? [vi.spyOn(StatementSync.prototype, "run")] : []),
  ];
  return async () => {
    await closeDatabase();
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "secret-metadata-worker-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDatabase();
  await state.cleanup();
});

it("reads exec and SecretRef values without caller-thread SQL and registers host redaction", async () => {
  const handoff = "github-setup-11111111111111111111111111111111";
  await writeEntries([
    entry("WORKER_READ_SECRET", "synthetic-worker-read"),
    entry("WORKER_READ_ENV", "synthetic-env", { kind: "env" }),
    entry(handoff, "synthetic-handoff"),
  ]);
  await closeDatabase();
  const assertNoCallerSql = spyOnCallerSql();
  resetSecretRedactionRegistryForTest();
  const value = await resolveSecretRefString(
    { source: "store", provider: "default", id: "WORKER_READ_SECRET" },
    { config: {}, env: state.env },
  );
  expect(isRegistered(value)).toBe(true);
  expect(value).toBe("synthetic-worker-read");
  resetSecretRedactionRegistryForTest();
  const environment = await readExec({ includeSecretSentinels: true });
  expect(isRegistered("synthetic-worker-read")).toBe(true);
  expect(environment.env).toEqual({ WORKER_READ_ENV: "synthetic-env" });
  expect(resolveSecretSentinel(environment.secretSentinels?.WORKER_READ_SECRET ?? "")).toBe(value);
  resetSecretRedactionRegistryForTest();
  expect(await consumeGitHubSetupHandoff({ name: handoff })).toBe("synthetic-handoff");
  expect(isRegistered("synthetic-handoff")).toBe(true);
  await assertNoCallerSql();
});

it("pins the physical read source before yielding and refuses revoked disclosure", async () => {
  await write("PINNED_SECRET", "synthetic-pinned-read");
  const env = { ...state.env };
  const reading = readValue({ scope, name: "PINNED_SECRET", database: { env } });
  env.OPENCLAW_STATE_DIR = state.statePath("replacement");
  expect(await reading).toEqual({ ok: true, value: "synthetic-pinned-read" });

  let current = true;
  const revoked = readValue({
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
  await writeEntries([
    entry("SELECTED_ONE", "synthetic-selected-one", { allowedHosts: ["one.example.test"] }),
    entry("SELECTED_TWO", "synthetic-selected-two", { allowedHosts: ["two.example.test"] }),
    entry("UNRELATED_SECRET", "synthetic-unrelated"),
    entry("READABLE_ENV", "synthetic-readable", { kind: "env" }),
    entry("DELETED_SECRET", "synthetic-deleted"),
  ]);
  await deleteSecretStoreEntry({ scope, name: "DELETED_SECRET" });
  await closeDatabase();
  const assertNoCallerSql = spyOnCallerSql(false);
  resetSecretRedactionRegistryForTest();
  expect(
    await readSelected({
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
  expect(isRegistered("synthetic-selected-one")).toBe(true);
  expect(isRegistered("synthetic-unrelated")).toBe(false);
  expect(isRegistered("synthetic-deleted")).toBe(false);
  await expect(
    readSelected({
      names: ["SELECTED_ONE"],
      assertCurrent: () => {
        throw new Error("selected authority revoked");
      },
    }),
  ).rejects.toThrow("selected authority revoked");
  await assertNoCallerSql();
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
  await closeDatabase();
  expect(await readValue({ scope, name: "OVERSIZED_VALUE" })).toMatchObject({
    ok: false,
    error: { code: "SECRET_STORE_UNAVAILABLE" },
  });
  await expect(readExec({ includeSecretSentinels: false })).rejects.toThrow("32 MiB read limit");
});

it("sets, lists, rolls back, and deletes metadata in FIFO order without caller-thread SQL", async () => {
  openOpenClawStateDatabase();
  await closeDatabase();
  const assertNoCallerSql = spyOnCallerSql();
  const original = {
    scope,
    updatedBy: "fixture",
    ...entry("WORKER_METADATA_SECRET", "synthetic-worker-original", {
      allowedHosts: ["original.example.test"],
    }),
  };
  const first = writeSecretStoreEntry(original);
  expect(isRegistered(original.value)).toBe(true);
  const second = writeSecretStoreEntry({
    ...original,
    value: "synthetic-worker-second",
    allowedHosts: ["second.example.test"],
    updatedBy: "second",
  });
  await Promise.all([first, second]);
  expect(await list()).toMatchObject([
    { name: original.name, updatedBy: "second", allowedHosts: ["second.example.test"] },
  ]);

  const staged = await writeWithRollback({
    ...original,
    kind: "env",
    value: "synthetic-staged-env",
    allowedHosts: undefined,
  });
  const rollingBack = staged.rollback();
  expect(staged.rollback()).toBe(rollingBack);
  expect(await rollingBack).toBe(true);
  const restored = await list();
  expect(restored).toMatchObject([
    {
      name: original.name,
      kind: "secret",
      updatedBy: "second",
      allowedHosts: ["second.example.test"],
    },
  ]);
  expect(restored[0]).not.toHaveProperty("valuePreview");

  const superseded = await writeWithRollback({ ...original, value: "synthetic-worker-superseded" });
  await writeSecretStoreEntry({ ...original, updatedBy: "successor" });
  expect(await superseded.rollback()).toBe(false);
  expect(await list()).toMatchObject([{ updatedBy: "successor" }]);

  const invalid = writeEntries(
    [entry("MUST_NOT_COMMIT", "synthetic-env", { kind: "env" }), entry("INVALID_SECRET", "")],
    "invalid-batch",
  );
  await expect(invalid).rejects.toBeInstanceOf(SecretStoreValidationError);
  await expect(invalid).rejects.toMatchObject({ code: "SECRET_STORE_VALUE_EMPTY" });
  expect(await list()).toHaveLength(1);
  await deleteSecretStoreEntry({ scope, name: original.name });
  expect(await list()).toEqual([]);
  expect(await list(true)).toHaveLength(1);
  await assertNoCallerSql();
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
              entry("FIRST_SECRET", "synthetic-first"),
              entry("SECOND_SECRET", "synthetic-second"),
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
    expect(await list(true)).toEqual([]);
  },
);

it("refuses a queued metadata write after its caller is revoked", async () => {
  let current = true;
  const operation = write("REVOKED_SECRET", "synthetic-revoked", {
    assertCurrent: () => {
      if (!current) {
        throw new Error("Synthetic caller authority revoked");
      }
    },
  });
  current = false;
  await expect(operation).rejects.toThrow("Synthetic caller authority revoked");
  expect(await list(true)).toEqual([]);
});
