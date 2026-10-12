import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { stateNativeProcessEntrypoints } from "./native-process-runtime.test-support.js";
import {
  hasPersistedOpenClawAgentCanonicalValidation,
  loadOpenClawAgentCanonicalValidationReceipt,
  recordOpenClawAgentCanonicalValidation,
} from "./openclaw-agent-canonical-validation-receipt.js";
import { assertOpenClawAgentSchemaContains } from "./openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

it.each(["legacy-birthtime", "missing-column"] as const)(
  "records canonical proof at the same schema version for %s receipts",
  async (legacy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
      const options = { agentId: "main", env };
      const original = openOpenClawAgentDatabase(options);
      if (legacy === "missing-column") {
        closeOpenClawAgentDatabaseByPath(original.path);
        using old = new DatabaseSync(original.path);
        old.exec("ALTER TABLE session_key_contract DROP COLUMN canonical_ready");
      }
      const database = openOpenClawAgentDatabase(options);
      const version = database.db.prepare("PRAGMA user_version").get();
      const schema = database.db.prepare("PRAGMA schema_version").get();
      if (legacy === "legacy-birthtime") {
        const file = statSync(database.path, { bigint: true });
        const birthtime = file.birthtimeNs.toString();
        database.db
          .prepare("UPDATE session_key_contract SET canonical_ready = ? WHERE id = 1")
          .run(JSON.stringify([1, "main", `${file.dev}:${file.ino}`, birthtime]));
        expect(loadOpenClawAgentCanonicalValidationReceipt(database)).toBe(
          process.platform !== "linux" || birthtime === "0",
        );
      } else {
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);
        expect(() =>
          runOpenClawAgentWriteTransaction((current) => {
            recordOpenClawAgentCanonicalValidation(current);
            throw new Error("rollback first receipt");
          }, options),
        ).toThrow("rollback first receipt");
        expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(schema);
        expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(false);
      }
      runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
      expect(hasPersistedOpenClawAgentCanonicalValidation(database)).toBe(true);
      if (legacy === "missing-column") {
        expect(
          database.db
            .prepare("PRAGMA table_info(session_key_contract)")
            .all()
            .find((column) => column.name === "canonical_ready"),
        ).toMatchObject({ type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
        const previousSchema = OPENCLAW_AGENT_SCHEMA_SQL.replace(
          /^\s*canonical_ready TEXT,\n/mu,
          "",
        );
        expect(() =>
          assertOpenClawAgentSchemaContains(database.db, database.path, previousSchema),
        ).not.toThrow();
        const completeSchema = database.db.prepare("PRAGMA schema_version").get();
        runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
        expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(completeSchema);
      } else {
        expect(database.db.prepare("PRAGMA schema_version").get()).toEqual(schema);
      }
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual(version);
    });
  },
);

it("requires admitted physical identity and write admission for persisted canonical receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const database = openOpenClawAgentDatabase(options);
    runOpenClawAgentWriteTransaction(recordOpenClawAgentCanonicalValidation, options);
    const raw = new DatabaseSync(database.path, { readOnly: true });
    try {
      expect(hasPersistedOpenClawAgentCanonicalValidation({ db: raw, agentId: "main" })).toBe(
        false,
      );
      expect(hasPersistedOpenClawAgentCanonicalValidation({ ...database, agentId: "other" })).toBe(
        false,
      );
      expect(() => recordOpenClawAgentCanonicalValidation(database)).toThrow("write admission");
    } finally {
      raw.close();
    }
  });
});

it("shares admitted canonical proof with readers and publishes repair changes only after commit", async () => {
  const result = await runNodeScript(
    (workerArgv) =>
      workerArgv(resolveRuntimeWorkerUrl(stateNativeProcessEntrypoints.canonicalReceipt)),
    process.env,
    undefined,
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
