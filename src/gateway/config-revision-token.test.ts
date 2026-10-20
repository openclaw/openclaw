import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getOpenClawStateRuntimeSchema } from "../state/openclaw-state-schema-compatibility.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createSqliteWorkerBackend } from "../state/openclaw-state.worker.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { loadGatewayConfigRevisionProjector } from "./config-revision-token.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  });
});

function stateOptions() {
  return { path: join(tempDirs.make("openclaw-config-revision-"), "openclaw.sqlite") };
}

describe("Gateway config revision tokens", () => {
  it("lazily persists one opaque domain-separated key without changing schema version", async () => {
    const options = stateOptions();
    const database = openOpenClawStateDatabase(options).db;
    const schemaVersion = database.prepare("PRAGMA user_version").get()?.user_version;
    database.exec("DROP TABLE config_revision_keys;");
    await closeStateDatabaseForTest();
    const reopened = openOpenClawStateDatabase(options).db;
    expect(tableExists(reopened, "config_revision_keys")).toBe(false);

    await closeStateDatabaseForTest();
    const projector = await loadGatewayConfigRevisionProjector(options);
    await closeStateDatabaseForTest();
    const storedDatabase = openOpenClawStateDatabase(options).db;
    const rawHash = "9ef81838b8fc191a44f1d20308dbb4e6d961dc7ee1294f9d4bd92471bde9475a";
    const rawToken = projector.projectRawHash(rawHash);
    const resolvedToken = projector.projectResolvedHash(rawHash);
    const keyRow = storedDatabase
      .prepare("SELECT hmac_key FROM config_revision_keys WHERE id = 1")
      .get() as { hmac_key: Uint8Array };
    const bearer = "synthetic-operator-password";
    const subject = projector.hashResponseSessionBearer(bearer);
    expect(subject).toMatch(/^hmac-sha256:v1:[a-f0-9]{64}$/u);
    expect(
      subject.includes(createHmac("sha256", keyRow.hmac_key).update(bearer).digest("hex")),
    ).toBe(false);
    expect(
      (await loadGatewayConfigRevisionProjector(stateOptions())).hashResponseSessionBearer(bearer),
    ).not.toBe(subject);

    expect(storedDatabase.prepare("PRAGMA user_version").get()?.user_version).toBe(schemaVersion);
    expect(keyRow.hmac_key).toHaveLength(32);
    expect(rawToken).toMatch(/^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u);
    expect(rawToken).not.toContain(rawHash);
    expect(rawToken).not.toContain(Buffer.from(keyRow.hmac_key).toString("hex"));
    expect(rawToken).not.toContain(Buffer.from(keyRow.hmac_key).toString("base64url"));
    expect(resolvedToken).not.toBe(rawToken);
    expect(projector.projectRawHash(rawHash)).toBe(rawToken);
    expect(projector.projectRawHash(`${rawHash}0`)).not.toBe(rawToken);
    expect(() =>
      assertSqliteSchemaContains(
        requireNativeSqliteDatabase(storedDatabase),
        "previous state-schema reader",
        getOpenClawStateRuntimeSchema({ includeVersionLazyAdditiveTables: false }),
      ),
    ).not.toThrow();

    await closeStateDatabaseForTest();
    expect((await loadGatewayConfigRevisionProjector(options)).projectRawHash(rawHash)).toBe(
      rawToken,
    );
    expect(
      (await loadGatewayConfigRevisionProjector(options)).hashResponseSessionBearer(bearer),
    ).toBe(subject);
  });

  it("reuses the persisted key with one statement and no transaction envelope", async () => {
    const options = stateOptions();
    const context = captureOpenClawStateWorkerContext(options);
    const run = <T>(operation: () => T) => runWithSqliteWorkerStateContext(context, operation);
    const backend = run(() =>
      createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
    );
    try {
      await backend[SQLITE_WORKER_PREPARE_COMMAND]?.("machineState.configRevisionKey");
      const load = (candidateKey: Uint8Array) =>
        run(() =>
          backend.execute({ type: "machineState.configRevisionKey", input: { candidateKey } }),
        );
      const key = load(Buffer.alloc(32, 1));
      const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      const exec = vi.spyOn(openOpenClawStateDatabase(options).db, "exec");
      try {
        expect(load(Buffer.alloc(32, 2))).toEqual(key);
        expect(reads.queries.filter((sql) => /\bconfig_revision_keys\b/i.test(sql))).toHaveLength(
          1,
        );
        expect(exec.mock.calls.filter(([sql]) => /\b(?:BEGIN|COMMIT)\b/i.test(sql))).toEqual([]);
      } finally {
        exec.mockRestore();
        reads.restore();
      }
    } finally {
      await backend.close();
    }
  });

  it("fails closed instead of replacing corrupt persisted key material", async () => {
    const options = stateOptions();
    await loadGatewayConfigRevisionProjector(options);
    await closeStateDatabaseForTest();
    const database = openOpenClawStateDatabase(options).db;
    database.exec("PRAGMA ignore_check_constraints = ON;");
    database
      .prepare("UPDATE config_revision_keys SET hmac_key = ? WHERE id = 1")
      .run(randomBytes(31));
    database.exec("PRAGMA ignore_check_constraints = OFF;");

    await closeStateDatabaseForTest();
    await expect(loadGatewayConfigRevisionProjector(options)).rejects.toThrow();
    await closeStateDatabaseForTest();
    // Inspect preserved corrupt bytes without readmitting the database.
    const { DatabaseSync } = requireNodeSqlite();
    const inspection = new DatabaseSync(options.path, { readOnly: true });
    try {
      expect(
        inspection
          .prepare("SELECT length(hmac_key) AS size FROM config_revision_keys WHERE id = 1")
          .get(),
      ).toEqual({ size: 31 });
    } finally {
      inspection.close();
    }
  });
});
