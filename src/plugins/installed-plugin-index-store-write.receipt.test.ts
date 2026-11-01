import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withoutMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  commitPluginInstallRecordsOnly,
  commitPluginInstallRecordsWithConfig,
} from "./install-record-commit.js";
import { indexStoreFixture } from "./installed-plugin-index-family.test-support.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease as writeRecords } from "./installed-plugin-index-records.js";
import {
  refreshPersistedInstalledPluginIndexWithLeaseSync as refreshIndexSync,
  restorePersistedInstalledPluginIndexIfCurrent as restoreIndex,
} from "./installed-plugin-index-store-write.js";
import { withPluginLifecycleLease as withLease } from "./plugin-lifecycle-lease.js";
import { createInstalledPluginIndex as createIndex } from "./test-helpers/installed-plugin-index.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const stateKey = "plugins.installedIndex";
const priorJson = `{ "revision": 41, "index": {
  "version": 1, "hostContractVersion": "2026.4.25", "compatRegistryVersion": "compat-v1",
  "migrationVersion": 1, "policyHash": "prior", "generatedAtMs": 123,
  "installRecords": {}, "plugins": [], "diagnostics": []
} }`;

function makeEnv() {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-plugin-row-receipt"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

function makeFixture() {
  const env = makeEnv();
  return indexStoreFixture(env.OPENCLAW_STATE_DIR, env);
}

function revocableAuthority() {
  const refused = new Error("plugin caller authority revoked");
  let current = true;
  return {
    refused,
    revoke(this: void) {
      current = false;
    },
    assertCurrent(this: void) {
      if (!current) {
        throw refused;
      }
    },
  };
}

function afterAcknowledgedIndexCommand(
  type:
    | "plugins.metadata.index.refresh"
    | "plugins.metadata.index.write"
    | "plugins.metadata.index.restore",
  acknowledged: () => void,
) {
  const run = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        store: SqliteWorkerStore<Operations>,
        operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        stateContext?: Parameters<typeof run>[2],
        assertCurrent?: Parameters<typeof run>[3],
        admission?: Parameters<typeof run>[4],
      ) =>
        run(
          store,
          (scope) =>
            operation({
              execute: async (command, options) => {
                const result = await scope.execute(command, options);
                if (command.type === type) {
                  acknowledged();
                }
                return result;
              },
            }),
          stateContext,
          assertCurrent,
          admission,
        ),
    );
}

describe("installed plugin index mutation receipts", () => {
  it("compensates an acknowledged index commit when caller authority ends before its reply", async () => {
    const f = makeFixture();
    const { env } = f;
    const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
    const config = { plugins: { enabled: false } };
    const configBytes = JSON.stringify(config);
    fs.writeFileSync(configPath, configBytes);
    const { refused, revoke, assertCurrent } = revocableAuthority();
    let acknowledgedWrites = 0;
    afterAcknowledgedIndexCommand("plugins.metadata.index.refresh", () => {
      expect(f.row()).not.toBeNull();
      acknowledgedWrites++;
      revoke();
    });
    await withEnvAsync({ ...env, OPENCLAW_CONFIG_PATH: configPath }, async () => {
      await expect(
        commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {},
          nextInstallRecords: {},
          nextConfig: { ...config, gateway: { port: 18792 } },
          writeOptions: { assertConfigPathForWrite: assertCurrent },
        }),
      ).rejects.toBe(refused);
      expect(acknowledgedWrites).toBe(1);
      expect(f.row()).toBeNull();
      expect(fs.readFileSync(configPath, "utf8")).toBe(configBytes);
    });
  });

  it.each(["write", "restore"] as const)(
    "invalidates cached inventory after an acknowledged %s loses caller authority",
    async (operation) => {
      const f = makeFixture();
      const { env } = f;
      await f.write(createIndex({ policyHash: "before", plugins: [] }));
      expect((await f.read())?.policyHash).toBe("before");
      const before = f.row();
      if (!before || typeof before.updated_at_ms !== "number") {
        throw new Error("Expected an initial installed-index revision");
      }
      const revision = before.updated_at_ms;
      const { refused, revoke, assertCurrent } = revocableAuthority();
      let acknowledgedWrites = 0;
      afterAcknowledgedIndexCommand(`plugins.metadata.index.${operation}`, () => {
        expect(f.row()).not.toEqual(before);
        acknowledgedWrites++;
        revoke();
      });
      await expect(
        withLease({ env, assertCurrent }, async (lease) => {
          if (operation === "restore") {
            await restoreIndex(null, revision, {
              env,
              lease,
            });
          } else {
            await f.write(createIndex({ policyHash: "after", plugins: [] }));
          }
        }),
      ).rejects.toBe(refused);
      expect(acknowledgedWrites).toBe(1);
      const fresh = await f.read();
      if (operation === "restore") {
        expect(fresh).toBeNull();
      } else {
        expect(fresh?.policyHash).toBe("after");
      }
    },
  );

  it("discards mutation receipts when the actual outer SQLite transaction rolls back", async () => {
    const f = makeFixture();
    const { env } = f;
    await withLease({ env }, async (lease) => {
      const failure = new Error("outer transaction rollback");
      expect(() =>
        f.transaction(() => {
          refreshIndexSync({
            reason: "source-changed",
            installRecords: {},
            candidates: [],
            env,
            lease,
          });
          throw failure;
        }),
      ).toThrow(failure);
      expect(f.row()).toBeNull();
    });
  });

  it.each([null, priorJson, "true"])(
    "retains exact predecessor and committed row for %s",
    async (valueJson) => {
      const f = makeFixture();
      const { env } = f;
      const otherEnv = makeEnv();
      await withLease({ env }, async (lease) => {
        if (valueJson !== null) {
          f.sql(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            stateKey,
            valueJson,
            9_007,
          );
        }
        const options = { env, filePath: lease.databasePath, candidates: [], lease };
        const persist = (writeEnv = f.env, assertCurrent?: () => void) =>
          withoutMainThreadSql(() =>
            writeRecords({}, { ...options, env: writeEnv, assertCurrent }),
          );
        const restore = (receipt: Awaited<ReturnType<typeof writeRecords>>) =>
          withoutMainThreadSql(() => restoreIndex(receipt.previous, receipt.revision, options));
        const before = f.row();
        const assertCurrent = vi.fn();
        const receipt = await persist(otherEnv, assertCurrent);
        const after = f.row();
        expect(receipt.mutation).toEqual({ databasePath: lease.databasePath, before, after });
        expect(receipt.mutation.after.updated_at_ms).toBe(receipt.revision);
        expect(JSON.parse(receipt.mutation.after.value_json).revision).toBe(receipt.revision);
        expect(receipt.previous?.policyHash ?? null).toBe(valueJson === priorJson ? "prior" : null);
        expect(lease.databasePath).toBe(f.databasePath);
        const captured = JSON.stringify(receipt.mutation);
        // The host connection is a foreign writer to the already-open metadata worker.
        f.sql(
          `UPDATE config_machine_state
                  SET value_json = json_set(value_json, '$.index.policyHash', 'foreign', '$.revision', ?),
                      updated_at_ms = ?
                WHERE state_key = ?`,
          receipt.revision + 1,
          receipt.revision + 1,
          stateKey,
        );
        const foreign = f.row();
        const successor = await persist();
        expect(successor.mutation.before).toEqual(foreign);
        expect(successor.previous?.policyHash).toBe("foreign");
        expect(successor.mutation.after).toEqual(f.row());
        expect(f.row()).not.toEqual(after);
        expect(JSON.stringify(receipt.mutation)).toBe(captured);
        await expect(restore(receipt)).resolves.toBe(false);
        await expect(restore(successor)).resolves.toBe(true);
      });
    },
  );

  it("refuses a malformed predecessor when cohort publication needs its record preimage", async () => {
    const f = makeFixture();
    const { env } = f;
    await withLease({ env }, async (lease) => {
      f.sql(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        stateKey,
        "true",
        9_007,
      );
      const before = f.row();
      expect(() =>
        refreshIndexSync({
          reason: "source-changed",
          installRecords: {},
          env,
          candidates: [],
          lease,
          pluginCohort: {
            runId: "221230eb-2b13-4b27-899f-9b3c98d21ed9",
            transactionId: "ab460a3d-62f0-4ac2-832f-0f3662893baf",
            installKey: env.OPENCLAW_STATE_DIR,
          },
        }),
      ).toThrow("Persisted plugin install records are invalid");
      expect(f.row()).toEqual(before);
      lease.assertCurrent();
    });
  });

  it.each([
    { operation: "refresh", stage: "transaction" },
    { operation: "refresh", stage: "commit" },
    { operation: "restore", stage: "transaction" },
    { operation: "restore", stage: "commit" },
  ] as const)(
    "preserves the committed row when $operation loses caller authority at $stage",
    async ({ operation, stage }) => {
      const f = makeFixture();
      const { env } = f;
      const { refused, revoke, assertCurrent } = revocableAuthority();
      let observedBoundary = false;
      let before;
      await expect(
        withLease(
          {
            env,
            ...(operation === "restore" ? { assertCurrent } : {}),
          },
          async (lease) => {
            const receipt = await writeRecords(
              { retained: { source: "npm", spec: "retained@1.0.0" } },
              { env, candidates: [], lease },
            );
            before = f.row();
            const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
            const admission = vi
              .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
              .mockImplementation((admit, attachment) =>
                createAdmission((request, grant) => {
                  if (
                    request.stage === stage &&
                    isRecord(request.facts) &&
                    request.facts.kind === "state-lease"
                  ) {
                    observedBoundary = true;
                    revoke();
                  }
                  admit(request, grant);
                }, attachment),
              );
            try {
              if (operation === "restore") {
                await restoreIndex(null, receipt.revision, {
                  env,
                  lease,
                });
              } else {
                await writeRecords(
                  { replacement: { source: "npm", spec: "replacement@2.0.0" } },
                  { env, candidates: [], lease, assertCurrent },
                );
              }
            } finally {
              admission.mockRestore();
            }
          },
        ),
      ).rejects.toBe(refused);
      expect(observedBoundary).toBe(true);
      expect(f.row()).toEqual(before);
    },
  );

  it.each([false, true])(
    "returns the row receipt only after caller settlement (fail=%s)",
    async (fail) => {
      const f = makeFixture();
      const { env } = f;
      const failure = new Error("config no longer current");
      await withEnvAsync(env, async () => {
        await withLease({}, async (lease) => {
          let after;
          const pending = commitPluginInstallRecordsOnly({
            nextInstallRecords: {},
            nextConfig: {},
            verifyConfigFresh: async () => {
              after = f.row();
              expect(after).not.toBeNull();
              if (fail) {
                throw failure;
              }
            },
          });
          if (fail) {
            await expect(pending).rejects.toBe(failure);
            expect(f.row()).toBeNull();
          } else {
            const receipt = await pending;
            expect(receipt?.mutation).toEqual({
              databasePath: lease.databasePath,
              before: null,
              after,
            });
          }
        });
      });
    },
  );

  it("rejects a failed SQLite commit without returning a receipt or publishing its row", async () => {
    const f = makeFixture();
    const { env } = f;
    await withLease({ env }, async (lease) => {
      let receipt;
      try {
        // A deferred constraint fails at COMMIT, after the index write and receipt capture.
        f.exec(`CREATE TEMP TABLE receipt_parent (id INTEGER PRIMARY KEY);
            CREATE TEMP TABLE receipt_child (
              parent_id INTEGER REFERENCES receipt_parent(id) DEFERRABLE INITIALLY DEFERRED
            );
            CREATE TEMP TRIGGER receipt_commit_failure AFTER INSERT ON main.config_machine_state
              WHEN NEW.state_key = 'plugins.installedIndex'
              BEGIN INSERT INTO receipt_child VALUES (1); END;`);
        // TEMP triggers belong to this connection; exercise the canonical worker kernel here.
        expect(() => {
          receipt = refreshIndexSync({
            reason: "source-changed",
            installRecords: {},
            env,
            filePath: lease.databasePath,
            candidates: [],
            lease,
          });
        }).toThrow(/FOREIGN KEY constraint failed/);
        expect(receipt).toBeUndefined();
        expect(f.row()).toBeNull();
      } finally {
        f.exec(`DROP TRIGGER IF EXISTS temp.receipt_commit_failure;
            DROP TABLE IF EXISTS temp.receipt_child;
            DROP TABLE IF EXISTS temp.receipt_parent;`);
      }
    });
  });
});
