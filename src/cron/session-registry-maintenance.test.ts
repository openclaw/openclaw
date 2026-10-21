import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resetConfigRuntimeState } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import * as cronStore from "./store.js";
import { makeCronReceiptJob } from "./store/run-receipt-store.test-support.js";

const DAY_MS = 24 * 60 * 60_000;
let state: OpenClawTestState;

function writeAgentDeletion(agentId: string, cleanupCompleted: boolean): void {
  const deletion = beginAgentDeletionJournal({
    agentId,
    operationId: randomUUID(),
    agentDir: state.agentDir(agentId),
    workspaceDir: state.path(`workspace-${agentId}`),
    sessionsDir: state.sessionsDir(agentId),
    deleteFiles: false,
  });
  if (cleanupCompleted) {
    runOpenClawStateWriteTransaction((database) =>
      completeAgentDeletionJournalInDatabase(database, deletion.agentId, deletion.operationId),
    );
  }
}

async function writeStaleCronSession(
  agentId: string,
  storePath = path.join(state.sessionsDir(agentId), "sessions.json"),
) {
  const sessionKey = `agent:${agentId}:cron:done-job:run:old-run`;
  const scope = { sessionKey, storePath };
  await replaceSessionEntry(scope, {
    sessionId: `${agentId}-old-run`,
    updatedAt: Date.now() - 8 * DAY_MS,
  });
  return scope;
}

function withMaintenanceState<Args extends unknown[]>(run: (...args: Args) => Promise<void>) {
  return (...args: Args) =>
    withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-session-registry-maintenance-" },
      async (fixture) => {
        state = fixture;
        resetConfigRuntimeState();
        setRuntimeConfigSnapshot({});
        await run(...args);
      },
    );
}

describe("runSessionRegistryMaintenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigRuntimeState();
    closeOpenClawAgentDatabasesForTest();
  });

  it(
    "skips the sweep instead of pruning when the cron store is unreadable",
    withMaintenanceState(async () => {
      const stale = await writeStaleCronSession("main");
      vi.spyOn(cronStore, "loadCronJobsStore").mockRejectedValue(
        new Error("cron store load unavailable"),
      );

      const summary = await runSessionRegistryMaintenance({
        apply: true,
        cronStorePath: state.statePath("cron/jobs.json"),
      });

      expect(summary.skippedReason).toContain("cron store unreadable");
      expect(summary.pruned).toBe(0);
      expect(loadSessionEntry(stale)).toBeDefined();
    }),
  );

  it(
    "preserves running jobs in the selected cron partition",
    withMaintenanceState(async () => {
      const scope = await writeStaleCronSession("main");
      const cronStorePath = state.statePath("custom-cron/jobs.json");
      const job = makeCronReceiptJob("done-job", "main");
      job.state.runningAtMs = Date.now();
      await cronStore.saveCronStore(cronStorePath, { version: 1, jobs: [job] });

      const summary = await runSessionRegistryMaintenance({ apply: true, cronStorePath });

      expect(summary).toMatchObject({ runningCronJobs: 1, pruned: 0 });
      expect(loadSessionEntry(scope)).toBeDefined();
    }),
  );

  it.each([
    "agent-database-inspection-pending",
    "agent-database-inspection-failed",
    "agent-database-ownership-mismatch",
  ] as const)(
    "defers registry pruning while another agent has %s",
    withMaintenanceState(async (code: AgentDatabaseAdmissionRefusal["code"]) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { slow: {}, healthy: {} } },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const slow = await writeStaleCronSession("slow");
      const healthy = await writeStaleCronSession("healthy");
      const child = { storePath: slow.storePath, sessionKey: "agent:slow:dashboard:child" };
      const childEntry = {
        sessionId: "cross-agent-child",
        updatedAt: now,
        spawnedBy: healthy.sessionKey,
      };
      await replaceSessionEntry(child, childEntry);
      const inspection = createAgentDatabaseInspectionRefusal({
        agentId: "slow",
        paths: [resolveSqliteTargetFromSessionStorePath(slow.storePath).path],
        pending: code === "agent-database-inspection-pending",
        reason: "Database is unavailable",
      });
      const refusal: AgentDatabaseAdmissionRefusal =
        code === "agent-database-ownership-mismatch"
          ? { ...inspection, code, embeddedOwnerId: "other-owner" }
          : inspection;
      recordAgentDatabaseAdmissions([refusal]);
      const params = { apply: true, cronStorePath: state.statePath("cron/jobs.json") };

      const waiting = await runSessionRegistryMaintenance(params);

      expect(waiting).toMatchObject({
        pruned: 0,
        skippedStores: 1,
        nextSweepAtMs: now + 60_000,
        skippedReason: "session child inventory incomplete",
        stores: expect.arrayContaining([
          {
            agentId: "slow",
            storePath: refusal.paths[0],
            skippedReason: code,
          },
        ]),
      });
      expect(loadSessionEntry(healthy)).toBeDefined();
      if (code !== "agent-database-inspection-pending") {
        return;
      }
      await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {
        expect(loadSessionEntry(slow)).toBeDefined();
      });

      const resumed = await runSessionRegistryMaintenance(params);

      expect(resumed).toMatchObject({ pruned: 1, skippedStores: 0 });
      expect(loadSessionEntry(slow)).toBeUndefined();
      expect(loadSessionEntry(healthy)).toBeDefined();
      await replaceSessionEntry(child, { ...childEntry, archivedAt: now });

      expect(await runSessionRegistryMaintenance(params)).toMatchObject({
        pruned: 1,
        skippedStores: 0,
      });
      expect(loadSessionEntry(healthy)).toBeUndefined();
    }),
  );

  it.each(["per-agent", "fixed selector", "exact database"])(
    "prunes every configured agent's stale cron rows with a %s store",
    withMaintenanceState(async (kind: string) => {
      const store =
        kind === "per-agent"
          ? undefined
          : state.statePath(kind === "fixed selector" ? "shared.json" : "shared.sqlite");
      const config: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
        ...(store ? { session: { store } } : {}),
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const scopes = [];
      for (const agentId of ["main", "beta"]) {
        scopes.push({ agentId, ...(await writeStaleCronSession(agentId, store)) });
      }

      if (kind === "per-agent") {
        // Preview isolates discovery from the lifecycle writer's live commit guards.
        const observation = observeHostDataSql();
        try {
          const preview = await runSessionRegistryMaintenance({
            apply: false,
            cronStorePath: state.statePath("cron/jobs.json"),
          });
          expect(preview.pruned).toBe(2);
          expect(
            observation.queries.filter((sql) =>
              /ambient-group-watch|database_paths_json|cleanup_paths_json/u.test(sql),
            ),
          ).toEqual([]);
        } finally {
          observation.restore();
        }
      }
      const summary = await runSessionRegistryMaintenance({
        apply: true,
        cronStorePath: state.statePath("cron/jobs.json"),
      });

      expect(summary.pruned).toBe(2);
      expect(summary.skippedReason).toBeUndefined();
      for (const scope of scopes) {
        expect(loadSessionEntry(scope)).toBeUndefined();
      }
    }),
  );

  it.each([
    { apply: false, cleanupCompleted: false },
    { apply: true, cleanupCompleted: false },
    { apply: false, cleanupCompleted: true },
    { apply: true, cleanupCompleted: true },
  ])(
    "skips agent deletions while maintaining healthy stores (apply=$apply, cleanupCompleted=$cleanupCompleted)",
    withMaintenanceState(
      async ({ apply, cleanupCompleted }: { apply: boolean; cleanupCompleted: boolean }) => {
        const main = await writeStaleCronSession("main");
        const retired = await writeStaleCronSession("retired");
        writeAgentDeletion("retired", cleanupCompleted);
        await closeOpenClawAgentDatabasesAsync(state.stateDir);

        const summary = await runSessionRegistryMaintenance({
          apply,
          cronStorePath: state.statePath("cron/jobs.json"),
        });

        expect(summary).toMatchObject({ pruned: 1, skippedStores: 1 });
        expect(summary.stores).toContainEqual(
          expect.objectContaining({ agentId: "main", pruned: 1 }),
        );
        expect(summary.stores).toContainEqual({
          agentId: "retired",
          storePath: retired.storePath,
          skippedReason: cleanupCompleted ? "agent-deletion-complete" : "agent-deletion-pending",
        });
        expect(loadSessionEntry(main) !== undefined).toBe(!apply);
      },
    ),
  );

  it.each(["missing", "reconstructed"])(
    "defers registry pruning while stores are held by %s deletion history",
    withMaintenanceState(async (history: string) => {
      const main = await writeStaleCronSession("main");
      const retained = await writeStaleCronSession("retained");
      const databasePath = resolveSqliteTargetFromSessionStorePath(retained.storePath).path;
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      runOpenClawStateWriteTransaction((database) => {
        database.db.exec("DROP TABLE agent_deletion_journal");
        if (history === "reconstructed") {
          reconstructAgentDeletionJournal(database, [{ agentId: "retained", path: databasePath }]);
        }
      });
      const bytes = await fs.readFile(databasePath);

      const summary = await runSessionRegistryMaintenance({
        apply: true,
        cronStorePath: state.statePath("cron/jobs.json"),
      });

      expect(summary).toMatchObject({
        pruned: 0,
        skippedStores: history === "missing" ? 2 : 1,
        skippedReason: "session child inventory incomplete",
      });
      expect(summary.stores).toContainEqual({
        agentId: "retained",
        storePath: retained.storePath,
        skippedReason: "agent-store-held",
        warning: expect.stringContaining(`Held agent retained database ${databasePath}`),
      });
      const held = summary.stores.find((store) => store.agentId === "retained");
      expect(held).toMatchObject({ warning: expect.stringContaining("openclaw doctor --fix") });
      expect(await fs.readFile(databasePath)).toEqual(bytes);
      expect(loadSessionEntry(retained)).toBeDefined();
      expect(loadSessionEntry(main)).toBeDefined();
    }),
  );

  it(
    "keeps a corrupt store terminal",
    withMaintenanceState(async () => {
      const retiredStorePath = path.join(state.sessionsDir("retired"), "sessions.json");
      openOpenClawStateDatabase();
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(retiredStorePath).path;
      if (!sqlitePath) {
        throw new Error("expected retired store to resolve to SQLite");
      }
      await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
      await fs.writeFile(sqlitePath, "not a sqlite database");
      await expect(
        runSessionRegistryMaintenance({
          apply: false,
          cronStorePath: state.statePath("cron/jobs.json"),
        }),
      ).rejects.toThrow();
    }),
  );
});
