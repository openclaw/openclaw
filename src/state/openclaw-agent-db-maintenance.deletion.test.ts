import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { withAgentDatabaseMaintenanceLease } from "./openclaw-agent-db-maintenance-lease.js";
import { migrateOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { seedLegacyAgentFixture } from "./openclaw-agent-db.test-support.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

it.for(["journal replaced", "lease expired"] as const)(
  "preserves legacy storage when deletion authority is %s after real integrity admission",
  (loss, { signal }) =>
    withOpenClawTestState({ label: "deletion-schema-authority" }, async (state) => {
      // Shared state exists before the frozen agent is installed; no candidate agent writer seeds it.
      openOpenClawStateDatabase({ env: state.env });
      const databasePath = path.join(state.agentDir("worker"), "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      {
        using database = new DatabaseSync(databasePath);
        seedLegacyAgentFixture(database, "worker");
      }
      registerOpenClawAgentDatabase({
        agentId: "worker",
        path: databasePath,
        schemaVersion: 24,
        env: state.env,
      });
      const original = fs.readFileSync(databasePath);
      const statePath = resolveOpenClawStateSqlitePath(state.env);
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      let interrupted = false;
      let clock: { mockRestore(): void } | undefined;
      const scan = vi
        .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
        .mockImplementationOnce(async (...args) => {
          await check(...args);
          signal.throwIfAborted();
          interrupted = true;
          if (loss === "lease expired") {
            // Expire deletion's 60s grant while the separate maintenance grant stays live.
            clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
            return;
          }
          using foreign = new DatabaseSync(statePath);
          const mutation = foreign
            .prepare(
              "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'worker'",
            )
            .run();
          expect(mutation.changes).toBe(1);
        });
      try {
        const failure: unknown = await withAgentDeletion(
          "worker",
          async (begin) => {
            const deletion = await begin({
              agentId: "worker",
              agentDir: state.agentDir("worker"),
              workspaceDir: state.workspaceDir,
              sessionsDir: state.sessionsDir("worker"),
              deleteFiles: false,
              phase: "retiring",
            });
            await withAgentDatabaseMaintenanceLease(
              { env: state.env, leaseMs: 120_000 },
              (maintenance) =>
                deletion.runDatabaseCleanup({ agentId: "worker", path: databasePath }, () =>
                  migrateOpenClawAgentDatabaseForMaintenance(
                    { agentId: "worker", pathname: databasePath, env: state.env, register: true },
                    maintenance,
                  ),
                ),
            );
          },
          { env: state.env },
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(interrupted, String(failure)).toBe(true);
        expect(String(failure)).toMatch(
          /no longer owns database cleanup|core:agent-deletion\/worker.*was lost/,
        );
        expect(scan).toHaveBeenCalledOnce();
      } finally {
        scan.mockRestore();
        clock?.mockRestore();
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      }
      expect(fs.readFileSync(databasePath)).toEqual(original);
      using legacy = new DatabaseSync(databasePath, { readOnly: true });
      expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
      expect(legacy.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      using shared = new DatabaseSync(statePath, { readOnly: true });
      expect(
        shared
          .prepare(`SELECT schema_version, cleanup_completed FROM agent_databases
        JOIN agent_deletion_journal USING (agent_id) WHERE agent_id = 'worker'`)
          .all(),
      ).toEqual([{ schema_version: 24, cleanup_completed: 0 }]);
    }),
);
