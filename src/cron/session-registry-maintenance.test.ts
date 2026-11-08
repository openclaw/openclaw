import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerRequests from "../infra/worker-request-diagnostics.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { runSessionRegistryMaintenance } from "./session-registry-maintenance.js";
import * as cronStore from "./store.js";
import * as cronReadStore from "./store/read-only.js";

const DAY_MS = 24 * 60 * 60_000;
let state: OpenClawTestState;
const maintain = (apply = true, cronStorePath = state.statePath("cron/jobs.json")) =>
  runSessionRegistryMaintenance({ apply, cronStorePath });
async function configure(config: OpenClawConfig) {
  await state.writeConfig(config);
  setRuntimeConfigSnapshot(config);
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

describe("runSessionRegistryMaintenance", () => {
  aroundEach((run) =>
    withOpenClawTestState(
      { layout: "state-only", label: "session-registry-maintenance" },
      async (fixture) => {
        state = fixture;
        setRuntimeConfigSnapshot({});
        await run();
      },
    ),
  );
  afterEach(() => vi.restoreAllMocks());

  it("skips the sweep instead of pruning when the cron store is unreadable", async () => {
    const stale = await writeStaleCronSession("main");
    vi.spyOn(cronReadStore, "loadCronJobsStoreWithConfigJobsReadOnly").mockRejectedValue(
      new Error("cron store load unavailable"),
    );

    const summary = await maintain();

    expect(summary.skippedReason).toContain("cron store unreadable");
    expect(summary.pruned).toBe(0);
    expect(loadSessionEntry(stale)).toBeDefined();
  });

  it.each([
    "agent-database-inspection-pending",
    "agent-database-inspection-failed",
    "agent-database-ownership-mismatch",
  ] as const)(
    "defers registry pruning while another agent has %s",
    async (code: AgentDatabaseAdmissionRefusal["code"]) => {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now);
      await configure({
        agents: { ownership: "explicit", entries: { slow: {}, healthy: {} } },
      });
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
      const waiting = await maintain();

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

      const resumed = await maintain();

      expect(resumed).toMatchObject({ pruned: 1, skippedStores: 0 });
      expect(loadSessionEntry(slow)).toBeUndefined();
      expect(loadSessionEntry(healthy)).toBeDefined();
      await replaceSessionEntry(child, { ...childEntry, archivedAt: now });

      expect(await maintain()).toMatchObject({ pruned: 1, skippedStores: 0 });
      expect(loadSessionEntry(healthy)).toBeUndefined();
    },
  );

  it.each(["per-agent", "fixed selector", "exact database"])(
    "prunes every configured agent's stale cron rows with a %s store",
    async (kind: string) => {
      const store =
        kind === "per-agent"
          ? undefined
          : state.statePath(kind === "fixed selector" ? "shared.json" : "shared.sqlite");
      await configure({
        agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
        ...(store ? { session: { store } } : {}),
      });
      const scopes = [];
      for (const agentId of ["main", "beta"]) {
        scopes.push({ agentId, ...(await writeStaleCronSession(agentId, store)) });
      }

      if (kind === "per-agent") {
        // Preview isolates discovery from the lifecycle writer's live commit guards.
        const cronPath = state.statePath("cron/jobs.json");
        await cronStore.saveCronStore(cronPath, {
          version: 1,
          jobs: [
            makeCronJob({ id: "done-job", agentId: "main", state: { runningAtMs: Date.now() } }),
          ],
        });
        const requests = vi.spyOn(workerRequests, "trackWorkerRequest");
        const observation = observeHostDataSql();
        try {
          expect(await maintain()).toMatchObject({ runningCronJobs: 1, pruned: 0 });
          expect(
            requests.mock.calls.filter(
              ([workerKind, label]) => workerKind === "sqlite_writer" && label === "cron",
            ),
          ).toHaveLength(0);
          requests.mockRestore();
          await cronStore.saveCronStore(cronPath, { version: 1, jobs: [] });
          const preview = await maintain(false);
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
      const summary = await maintain();
      expect(summary.pruned).toBe(2);
      expect(summary.skippedReason).toBeUndefined();
      for (const scope of scopes) {
        expect(loadSessionEntry(scope)).toBeUndefined();
      }
    },
  );

  it.each(["missing", "reconstructed"])(
    "defers registry pruning while stores are held by %s deletion history",
    async (history: string) => {
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

      const summary = await maintain();

      expect(summary).toMatchObject({
        pruned: 0,
        skippedStores: history === "missing" ? 2 : 1,
        skippedReason: "session child inventory incomplete",
      });
      expect(summary.stores).toContainEqual({
        agentId: "retained",
        storePath: retained.storePath,
        skippedReason: "agent-store-held",
        warning: expect.stringContaining("openclaw doctor --fix"),
      });
      expect(await fs.readFile(databasePath)).toEqual(bytes);
      expect(loadSessionEntry(retained)).toBeDefined();
      expect(loadSessionEntry(main)).toBeDefined();
    },
  );

  it("keeps a corrupt store terminal", async () => {
    const retiredStorePath = path.join(state.sessionsDir("retired"), "sessions.json");
    openOpenClawStateDatabase();
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(retiredStorePath).path;
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    await fs.writeFile(sqlitePath, "not a sqlite database");
    await expect(maintain(false)).rejects.toThrow();
  });
});
