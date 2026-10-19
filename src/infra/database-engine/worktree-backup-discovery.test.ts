import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withWorktreeAllocationLease } from "../../agents/worktrees/allocation.js";
import { reservePendingWorktree } from "../../agents/worktrees/pending-slots.js";
import { readExistingWorktreePaths } from "../../agents/worktrees/registry-read.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { resolveBackupPlanFromDisk } from "../../commands/backup-shared.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db-contract.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type {
  OpenClawStateReadCommand,
  OpenClawStateReadOptions,
} from "../../state/openclaw-state-read.types.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { installDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import { getPostgresPhysicalFacts } from "./physical-facts.js";
import { resolveDatabaseFamilyEngines } from "./registry.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;

function record(root: string, id: string): ManagedWorktreeRecord {
  return {
    id,
    name: id,
    repoRoot: root,
    repoFingerprint: "0123456789abcdef",
    path: path.join(root, "checkouts", id),
    branch: `worktree/${id}`,
    baseRef: "HEAD",
    ownerKind: "session",
    ownerId: `agent:main:${id}`,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

describe.each(["sqlite", "postgres"] as const)("%s worktree backup discovery", (engine) => {
  it.skipIf(engine === "postgres" && !connection)(
    "retains pending publication in one read generation and includes recovering custody",
    async () => {
      await withOpenClawTestState(
        { prefix: "worktree-backup-discovery-", scenario: "minimal" },
        async (state) => {
          installDatabaseEngineSelection({
            effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
            ...(engine === "postgres"
              ? { postgres: { connection: connection!, schemaPrefix: "worktree_backup" } }
              : {}),
          });
          const client =
            engine === "postgres" ? new Client({ connectionString: connection }) : undefined;
          await client?.connect();
          let namespace: string | undefined;
          try {
            namespace = withEngineStoreAdmission(
              () =>
                getPostgresPhysicalFacts(openOpenClawStateDatabase({ env: state.env }).db)
                  ?.namespace,
            );
            const live = record(state.root, "live");
            const removed = { ...record(state.root, "removed"), removedAt: 2 };
            const recovering = record(state.root, "recovering");
            const pending = record(state.root, "pending");
            await insertRegistryWorktree(state.env, live);
            await insertRegistryWorktree(state.env, removed);
            await withWorktreeAllocationLease(
              { env: state.env, id: recovering.id },
              async (guard) => {
                await reservePendingWorktree(state.env, recovering, guard.workerAuthority);
              },
            );
            // Persist the existing interrupted-allocation state; discovery must not recover it.
            withEngineStoreAdmission(() =>
              runOpenClawStateWriteTransaction(
                ({ db }) => {
                  db.prepare(
                    "UPDATE state_leases SET payload_json = ? WHERE scope = ? AND lease_key = ?",
                  ).run(
                    JSON.stringify({ record: recovering, state: "recovering" }),
                    "core:managed-worktrees:pending-slots",
                    recovering.id,
                  );
                },
                { env: state.env },
              ),
            );
            await withWorktreeAllocationLease({ env: state.env, id: pending.id }, async (guard) => {
              await reservePendingWorktree(state.env, pending, guard.workerAuthority);
              const published = createDeferred();
              const execute = stateReads.executeExistingOpenClawStateRead;
              // Gate transport only: both reads and the atomic pending→live publication stay real.
              const intercept = vi
                .spyOn(stateReads, "executeExistingOpenClawStateRead")
                .mockImplementation(
                  async <Command extends OpenClawStateReadCommand>(
                    options: OpenClawStateDatabaseOptions,
                    command: Command,
                    readOptions?: OpenClawStateReadOptions,
                  ) => {
                    if (command.type === "worktrees.pendingSlots") {
                      await published.promise;
                    }
                    try {
                      const reply = await execute(options, command, readOptions);
                      if (command.type === "worktrees.livePaths") {
                        await insertRegistryWorktree(state.env, pending, {
                          pendingId: pending.id,
                          workerAuthority: guard.workerAuthority,
                        });
                        published.resolve();
                      }
                      return reply;
                    } catch (error) {
                      if (command.type === "worktrees.livePaths") {
                        published.reject(error);
                      }
                      throw error;
                    }
                  },
                );
              try {
                expect((await readExistingWorktreePaths(state.env)).toSorted()).toEqual(
                  [live.path, pending.path, recovering.path].toSorted(),
                );
              } finally {
                intercept.mockRestore();
              }
            });
            expect((await readExistingWorktreePaths(state.env)).toSorted()).toEqual(
              [live.path, pending.path, recovering.path].toSorted(),
            );
          } finally {
            await closeStateDatabaseForTest();
            resetDatabaseEngineSelectionForTest();
            try {
              if (namespace) {
                await client?.query(`DROP SCHEMA "${namespace}" CASCADE`);
              }
            } finally {
              await client?.end();
            }
          }
        },
      );
    },
  );
});

it("leaves absent state absent and reports registry corruption except for config-only export", async () => {
  await withOpenClawTestState(
    { prefix: "worktree-backup-absent-", scenario: "minimal" },
    async (state) => {
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      expect(await readExistingWorktreePaths(state.env)).toEqual([]);
      await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      const pending = record(state.root, "invalid-slot");
      await withWorktreeAllocationLease({ env: state.env, id: pending.id }, async (guard) => {
        await reservePendingWorktree(state.env, pending, guard.workerAuthority);
      });
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "UPDATE state_leases SET payload_json = ? WHERE scope = ? AND lease_key = ?",
          ).run("{invalid", "core:managed-worktrees:pending-slots", pending.id);
        },
        { env: state.env },
      );
      await expect(readExistingWorktreePaths(state.env)).rejects.toThrow(
        "Invalid pending worktree slot",
      );
      await expect(resolveBackupPlanFromDisk({ includeWorkspace: false })).rejects.toThrow(
        "Invalid pending worktree slot",
      );
      const configOnly = await resolveBackupPlanFromDisk({ onlyConfig: true });
      expect(configOnly.included.map((asset) => asset.kind)).toEqual(["config"]);
    },
  );
});
