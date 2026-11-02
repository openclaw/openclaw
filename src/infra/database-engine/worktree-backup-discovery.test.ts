import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withWorktreeAllocationLease } from "../../agents/worktrees/allocation.js";
import { reservePendingWorktree } from "../../agents/worktrees/pending-slots.js";
import { readExistingWorktreePaths } from "../../agents/worktrees/registry-read.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import { makeWorktreeRecord } from "../../agents/worktrees/service.test-support.js";
import { resolveBackupPlanFromDisk } from "../../commands/backup-shared.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawStateReadCommand } from "../../state/openclaw-state-read.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function record(root: string, id: string) {
  return makeWorktreeRecord(root, id, {
    path: path.join(root, "checkouts", id),
    branch: `worktree/${id}`,
    ownerId: `agent:main:${id}`,
  });
}

function writePendingPayload(env: NodeJS.ProcessEnv, id: string, payload: string) {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare("UPDATE state_leases SET payload_json = ? WHERE scope = ? AND lease_key = ?").run(
        payload,
        "core:managed-worktrees:pending-slots",
        id,
      );
    },
    { env },
  );
}

describe.each(["sqlite", "postgres"] as const)("%s worktree backup discovery", (engine) => {
  const fixture = useMixedAgentPair(engine, engine);
  it.skipIf(engine === "postgres" && !mixedAgentConnection)(
    "retains pending publication in one read generation and includes recovering custody",
    async () => {
      const state = { root: fixture.root, env: process.env };
      const live = record(state.root, "live");
      const removed = { ...record(state.root, "removed"), removedAt: 2 };
      const recovering = record(state.root, "recovering");
      const pending = record(state.root, "pending");
      await insertRegistryWorktree(state.env, live);
      await insertRegistryWorktree(state.env, removed);
      await withWorktreeAllocationLease({ env: state.env, id: recovering.id }, async (guard) => {
        await reservePendingWorktree(state.env, recovering, guard.workerAuthority);
      });
      // Persist the existing interrupted-allocation state; discovery must not recover it.
      withEngineStoreAdmission(() =>
        writePendingPayload(
          state.env,
          recovering.id,
          JSON.stringify({ record: recovering, state: "recovering" }),
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
              ...args: Parameters<typeof execute<Command>>
            ) => {
              const command = args[1];
              if (command.type === "worktrees.pendingSlots") {
                await published.promise;
              }
              try {
                const reply = await execute(...args);
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
      writePendingPayload(state.env, pending.id, "{invalid");
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
