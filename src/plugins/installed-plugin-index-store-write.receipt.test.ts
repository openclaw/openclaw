import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { SqliteWorkerOperations, SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../infra/sqlite-worker-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  commitPluginInstallRecordsOnly,
  commitPluginInstallRecordsWithConfig,
} from "./install-record-commit.js";
import { writePersistedInstalledPluginIndexInstallRecordsWithLease } from "./installed-plugin-index-records.js";
import {
  refreshPersistedInstalledPluginIndexWithLeaseSync,
  restorePersistedInstalledPluginIndexIfCurrent,
  writePersistedInstalledPluginIndex,
} from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndex } from "./installed-plugin-index-store.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { createInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";

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

async function withoutMainThreadSql<T>(run: () => Promise<T>): Promise<T> {
  const sql = observeMainThreadSql();
  try {
    const result = await run();
    sql.expectIdle();
    return result;
  } finally {
    sql.restore();
  }
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

// An independent connection sees only committed rows, not the writer's projections.
function readRow(databasePath: string) {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (
      db
        .prepare(
          "SELECT state_key, value_json, updated_at_ms FROM config_machine_state WHERE state_key = ?",
        )
        .get(stateKey) ?? null
    );
  } finally {
    db.close();
  }
}

describe("installed plugin index mutation receipts", () => {
  it("collects only committed index writes and their owned compensation", async () => {
    const env = makeEnv();
    await withEnvAsync(env, () =>
      withPluginLifecycleLease({}, async (lease) => {
        const failure = new Error("source changed after index publication");
        await expect(
          commitPluginInstallRecordsOnly({
            nextInstallRecords: {},
            nextConfig: {},
            verifyConfigFresh: async () => {
              throw failure;
            },
          }),
        ).rejects.toBe(failure);
        expect(readRow(lease.databasePath)).toBeNull();
      }),
    );
  });

  it("compensates an acknowledged index commit when caller authority ends before its reply", async () => {
    const env = makeEnv();
    const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
    const databasePath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const config = { plugins: { enabled: false } };
    const configBytes = JSON.stringify(config);
    fs.writeFileSync(configPath, configBytes);
    const refused = new Error("plugin administrator authority revoked after index commit");
    let current = true;
    let acknowledgedWrites = 0;
    afterAcknowledgedIndexCommand("plugins.metadata.index.refresh", () => {
      expect(readRow(databasePath)).not.toBeNull();
      acknowledgedWrites++;
      current = false;
    });
    await withEnvAsync({ ...env, OPENCLAW_CONFIG_PATH: configPath }, async () => {
      await expect(
        commitPluginInstallRecordsWithConfig({
          previousInstallRecords: {},
          nextInstallRecords: {},
          nextConfig: { ...config, gateway: { port: 18792 } },
          writeOptions: {
            assertConfigPathForWrite: () => {
              if (!current) {
                throw refused;
              }
            },
          },
        }),
      ).rejects.toBe(refused);
      expect(acknowledgedWrites).toBe(1);
      expect(readRow(databasePath)).toBeNull();
      expect(fs.readFileSync(configPath, "utf8")).toBe(configBytes);
    });
  });

  it.each(["write", "restore"] as const)(
    "invalidates cached inventory after an acknowledged %s loses caller authority",
    async (operation) => {
      const env = makeEnv();
      const databasePath = await writePersistedInstalledPluginIndex(
        createInstalledPluginIndex({ policyHash: "before", plugins: [] }),
        { env },
      );
      expect((await readPersistedInstalledPluginIndex({ env }))?.policyHash).toBe("before");
      const before = readRow(databasePath);
      if (!before || typeof before.updated_at_ms !== "number") {
        throw new Error("Expected an initial installed-index revision");
      }
      const revision = before.updated_at_ms;
      const refused = new Error("plugin caller revoked after acknowledged mutation");
      let current = true;
      let acknowledgedWrites = 0;
      afterAcknowledgedIndexCommand(`plugins.metadata.index.${operation}`, () => {
        expect(readRow(databasePath)).not.toEqual(before);
        acknowledgedWrites++;
        current = false;
      });
      await expect(
        withPluginLifecycleLease(
          {
            env,
            assertCurrent() {
              if (!current) {
                throw refused;
              }
            },
          },
          async (lease) => {
            if (operation === "restore") {
              await restorePersistedInstalledPluginIndexIfCurrent(null, revision, {
                env,
                lease,
              });
            } else {
              await writePersistedInstalledPluginIndex(
                createInstalledPluginIndex({ policyHash: "after", plugins: [] }),
                { env },
              );
            }
          },
        ),
      ).rejects.toBe(refused);
      expect(acknowledgedWrites).toBe(1);
      const fresh = await readPersistedInstalledPluginIndex({ env });
      if (operation === "restore") {
        expect(fresh).toBeNull();
      } else {
        expect(fresh?.policyHash).toBe("after");
      }
    },
  );

  it("discards mutation receipts when the actual outer SQLite transaction rolls back", async () => {
    const env = makeEnv();
    await withPluginLifecycleLease({ env }, async (lease) => {
      const failure = new Error("outer transaction rollback");
      expect(() =>
        runOpenClawStateWriteTransaction(
          () => {
            refreshPersistedInstalledPluginIndexWithLeaseSync({
              reason: "source-changed",
              installRecords: {},
              candidates: [],
              env,
              lease,
            });
            throw failure;
          },
          { env },
        ),
      ).toThrow(failure);
      expect(readRow(lease.databasePath)).toBeNull();
    });
  });

  it.each([null, priorJson, "true"])(
    "retains exact predecessor and committed row for %s",
    async (valueJson) => {
      const env = makeEnv();
      const otherEnv = makeEnv();
      await withPluginLifecycleLease({ env }, async (lease) => {
        if (valueJson !== null) {
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              db.prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              ).run(stateKey, valueJson, 9_007);
            },
            { path: lease.databasePath, env },
          );
        }
        const before = readRow(lease.databasePath);
        const assertCurrent = vi.fn();
        const receipt = await withoutMainThreadSql(() =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            {},
            {
              env: otherEnv,
              filePath: lease.databasePath,
              candidates: [],
              lease,
              assertCurrent,
            },
          ),
        );
        // Preparation, transaction, commit and disclosure each check current authority once.
        expect(assertCurrent).toHaveBeenCalledTimes(4);
        const after = readRow(lease.databasePath);
        expect(receipt.mutation).toEqual({ databasePath: lease.databasePath, before, after });
        expect(receipt.mutation.before).toEqual(
          valueJson === null
            ? null
            : {
                state_key: stateKey,
                value_json: valueJson,
                updated_at_ms: 9_007,
              },
        );
        expect(receipt.mutation.after.updated_at_ms).toBe(receipt.revision);
        expect(JSON.parse(receipt.mutation.after.value_json).revision).toBe(receipt.revision);
        expect(receipt.previous?.policyHash ?? null).toBe(valueJson === priorJson ? "prior" : null);
        expect(lease.databasePath).toBe(
          path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite"),
        );
        const captured = JSON.stringify(receipt.mutation);
        // The host connection is a foreign writer to the already-open metadata worker.
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.prepare(
              `UPDATE config_machine_state
                  SET value_json = json_set(value_json, '$.index.policyHash', 'foreign', '$.revision', ?),
                      updated_at_ms = ?
                WHERE state_key = ?`,
            ).run(receipt.revision + 1, receipt.revision + 1, stateKey);
          },
          { path: lease.databasePath, env },
        );
        const foreign = readRow(lease.databasePath);
        const successor = await withoutMainThreadSql(() =>
          writePersistedInstalledPluginIndexInstallRecordsWithLease(
            {},
            {
              env,
              filePath: lease.databasePath,
              candidates: [],
              lease,
            },
          ),
        );
        expect(successor.mutation.before).toEqual(foreign);
        expect(successor.previous?.policyHash).toBe("foreign");
        expect(readRow(lease.databasePath)).not.toEqual(after);
        expect(JSON.stringify(receipt.mutation)).toBe(captured);
        await expect(
          withoutMainThreadSql(() =>
            restorePersistedInstalledPluginIndexIfCurrent(receipt.previous, receipt.revision, {
              env,
              lease,
            }),
          ),
        ).resolves.toBe(false);
        await expect(
          withoutMainThreadSql(() =>
            restorePersistedInstalledPluginIndexIfCurrent(successor.previous, successor.revision, {
              env,
              lease,
            }),
          ),
        ).resolves.toBe(true);
      });
    },
  );

  it.each([
    { operation: "refresh", stage: "transaction" },
    { operation: "refresh", stage: "commit" },
    { operation: "restore", stage: "transaction" },
    { operation: "restore", stage: "commit" },
  ] as const)(
    "preserves the committed row when $operation loses caller authority at $stage",
    async ({ operation, stage }) => {
      const env = makeEnv();
      const refused = new Error("plugin administrator authority revoked");
      let current = true;
      let observedBoundary = false;
      let before;
      let databasePath = "";
      const assertCurrent = () => {
        if (!current) {
          throw refused;
        }
      };
      await expect(
        withPluginLifecycleLease(
          {
            env,
            ...(operation === "restore" ? { assertCurrent } : {}),
          },
          async (lease) => {
            databasePath = lease.databasePath;
            const receipt = await writePersistedInstalledPluginIndexInstallRecordsWithLease(
              { retained: { source: "npm", spec: "retained@1.0.0" } },
              { env, candidates: [], lease },
            );
            before = readRow(databasePath);
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
                    current = false;
                  }
                  admit(request, grant);
                }, attachment),
              );
            try {
              if (operation === "restore") {
                await restorePersistedInstalledPluginIndexIfCurrent(null, receipt.revision, {
                  env,
                  lease,
                });
              } else {
                await writePersistedInstalledPluginIndexInstallRecordsWithLease(
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
      expect(readRow(databasePath)).toEqual(before);
    },
  );

  it.each([false, true])(
    "returns the row receipt only after caller settlement (fail=%s)",
    async (fail) => {
      const env = makeEnv();
      await withEnvAsync(env, async () => {
        await withPluginLifecycleLease({}, async (lease) => {
          let after;
          const pending = commitPluginInstallRecordsOnly({
            nextInstallRecords: {},
            nextConfig: {},
            verifyConfigFresh: async () => {
              after = readRow(lease.databasePath);
              expect(after).not.toBeNull();
              if (fail) {
                throw new Error("config no longer current");
              }
            },
          });
          if (fail) {
            await expect(pending).rejects.toThrow("config no longer current");
            expect(readRow(lease.databasePath)).toBeNull();
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
    const env = makeEnv();
    await withPluginLifecycleLease({ env }, async (lease) => {
      let receipt;
      try {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            // A deferred constraint fails at COMMIT, after the index write and receipt capture.
            db.exec(`CREATE TEMP TABLE receipt_parent (id INTEGER PRIMARY KEY);
            CREATE TEMP TABLE receipt_child (
              parent_id INTEGER REFERENCES receipt_parent(id) DEFERRABLE INITIALLY DEFERRED
            );
            CREATE TEMP TRIGGER receipt_commit_failure AFTER INSERT ON main.config_machine_state
              WHEN NEW.state_key = 'plugins.installedIndex'
              BEGIN INSERT INTO receipt_child VALUES (1); END;`);
          },
          { path: lease.databasePath, env },
        );
        // TEMP triggers belong to this connection; exercise the canonical worker kernel here.
        expect(() => {
          receipt = refreshPersistedInstalledPluginIndexWithLeaseSync({
            reason: "source-changed",
            installRecords: {},
            env,
            filePath: lease.databasePath,
            candidates: [],
            lease,
          });
        }).toThrow(/FOREIGN KEY constraint failed/);
        expect(receipt).toBeUndefined();
        expect(readRow(lease.databasePath)).toBeNull();
      } finally {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            db.exec(`DROP TRIGGER IF EXISTS temp.receipt_commit_failure;
            DROP TABLE IF EXISTS temp.receipt_child;
            DROP TABLE IF EXISTS temp.receipt_parent;`);
          },
          { path: lease.databasePath, env },
        );
      }
    });
  });
});
