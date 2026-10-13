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
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

it.for(["journal replaced", "lease expired"] as const)(
  "preserves legacy storage when deletion authority is %s after real integrity admission",
  async (loss, { signal }) => {
    await withOpenClawTestState({ label: "deletion-schema-authority" }, async (state) => {
      // Shared state exists before the frozen agent is installed; no candidate agent writer seeds it.
      openOpenClawStateDatabase({ env: state.env });
      const databasePath = path.join(state.agentDir("worker"), "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(
          fs
            .readFileSync(
              new URL("../../test/fixtures/sqlite/openclaw-agent-v2026.9.9.sql", import.meta.url),
              "utf8",
            )
            .replaceAll("keeper", "worker"),
        );
      } finally {
        database.close();
      }
      registerOpenClawAgentDatabase({
        agentId: "worker",
        path: databasePath,
        schemaVersion: 24,
        env: state.env,
      });
      const original = fs.readFileSync(databasePath);
      const check = integrityWorker.assertSqliteIntegrityInWorker;
      let interrupted = false;
      const scan = vi
        .spyOn(integrityWorker, "assertSqliteIntegrityInWorker")
        .mockImplementationOnce(async (...args) => {
          await check(...args);
          signal.throwIfAborted();
          const foreign = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
          try {
            const mutation =
              loss === "journal replaced"
                ? foreign
                    .prepare(
                      "UPDATE agent_deletion_journal SET operation_id = 'replacement' WHERE agent_id = 'worker'",
                    )
                    .run()
                : foreign
                    .prepare(
                      "UPDATE state_leases SET expires_at = 0 WHERE scope = 'core:agent-deletion' AND lease_key = 'worker'",
                    )
                    .run();
            expect(mutation.changes).toBe(1);
            interrupted = true;
          } finally {
            foreign.close();
          }
        });
      try {
        let failure: unknown;
        await withAgentDeletion(
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
            await withAgentDatabaseMaintenanceLease({ env: state.env }, (maintenance) =>
              deletion.runDatabaseCleanup({ agentId: "worker", path: databasePath }, () =>
                migrateOpenClawAgentDatabaseForMaintenance(
                  { agentId: "worker", pathname: databasePath, env: state.env, register: true },
                  maintenance,
                ),
              ),
            );
          },
          { env: state.env },
        ).catch((error: unknown) => {
          failure = error;
        });
        expect(failure).toBeInstanceOf(Error);
        expect(interrupted, String(failure)).toBe(true);
        expect(String(failure)).toMatch(
          /no longer owns database cleanup|core:agent-deletion\/worker.*was lost/,
        );
        expect(scan).toHaveBeenCalledOnce();
      } finally {
        scan.mockRestore();
        await cleanupSessionStateForTest({ stateDir: state.stateDir, rootPath: state.root });
      }
      expect(fs.readFileSync(databasePath)).toEqual(original);
      const legacy = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(legacy.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
        expect(legacy.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      } finally {
        legacy.close();
      }
      const shared = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env), {
        readOnly: true,
      });
      try {
        expect(
          shared
            .prepare("SELECT schema_version FROM agent_databases WHERE agent_id = 'worker'")
            .all(),
        ).toEqual([{ schema_version: 24 }]);
        expect(
          shared
            .prepare(
              "SELECT cleanup_completed FROM agent_deletion_journal WHERE agent_id = 'worker'",
            )
            .get()?.cleanup_completed,
        ).toBe(0);
      } finally {
        shared.close();
      }
    });
  },
);
