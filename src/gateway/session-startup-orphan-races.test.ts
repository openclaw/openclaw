import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, assert, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveCompletionFromSessionEntry } from "../agents/subagents/registry/subagent-session-reconciliation.js";
import * as accessor from "../config/sessions/session-accessor.js";
import { readSessionEntriesByStatus } from "../config/sessions/session-accessor.sqlite-status.js";
import * as transcriptReports from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { registerAgentRunContext, clearAgentRunContext } from "../infra/agent-run-registry.js";
import { acquireGatewayLock } from "../infra/gateway-lock.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { ensureSessionEntryValidityProjection } from "../state/openclaw-agent-db-session-migrations.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  prepareGatewayStartupSessions,
  runGatewaySessionStartupMaintenance,
} from "./server-startup-session-migration.js";
import { runStartupSessionMaintenanceForTest } from "./server-startup-session-migration.test-support.js";

const roots = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    clearAgentRunContext("startup-race-owner");
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

async function withStartupGateway(label: string, run: () => Promise<void>, afterRun?: () => void) {
  const stateDir = fs.realpathSync.native(roots.make(label));
  await withEnvAsync(
    { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json") },
    async () => {
      const lock = await acquireGatewayLock({
        allowInTests: true,
        port: 24120,
        listenerMode: "foreground",
      });
      if (!lock) {
        throw new Error("expected isolated Gateway ownership");
      }
      try {
        await lock.run(run);
      } finally {
        afterRun?.();
        await closeOpenClawAgentDatabasesAsync(stateDir);
        closeOpenClawAgentDatabasesForTest();
        await lock.release();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
}

it.each([
  "session",
  "generation",
  "archive-state",
  "restored-archive",
  "local-owner",
  "session-admission",
  "durable-owner",
  "snapshot-owner",
  "snapshot-lease-release",
  "snapshot-lease-replace",
] as const)(
  "retains the row and emits no receipt when %s changes after repair preparation",
  async (race) => {
    let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
    await withStartupGateway(
      "startup-orphan-race-",
      async () => {
        const scope = { agentId: "main", sessionKey: "agent:main:dashboard:race" };
        await accessor.replaceSessionEntry(scope, {
          sessionId: "predecessor",
          lifecycleRevision: "generation-1",
          lifecycleRunId: "run-1",
          spawnDepth: 1,
          abortedLastRun: true,
          restartRecoveryForceSafeTools: true,
          ...(race === "restored-archive"
            ? { archivedAt: Math.floor(performance.timeOrigin) - 100 }
            : {}),
          status: "running",
          startedAt: Math.floor(performance.timeOrigin) - 100,
          updatedAt: Math.floor(performance.timeOrigin) - 100,
        });
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const original = accessor.loadSessionEntryReadOnly(scope);
        assert(original);
        const settle = transcriptReports.settleStartupSession;
        let prepared = false;
        vi.spyOn(transcriptReports, "settleStartupSession").mockImplementationOnce(
          async (...args) => {
            await Promise.resolve();
            if (race === "session") {
              accessor.replaceSessionEntrySync(scope, {
                ...original,
                sessionId: "successor",
              });
            } else if (race === "archive-state" || race === "restored-archive") {
              const next = { ...original };
              if (race === "archive-state") {
                next.archivedAt = Math.floor(performance.timeOrigin) - 50;
              } else {
                delete next.archivedAt;
              }
              accessor.replaceSessionEntrySync(scope, next);
            } else if (race === "generation") {
              // Keep the separate connection, but serialize its write with maintenance.
              await runOpenClawAgentWriteAdmission({ agentId: "main", path: database.path }, () => {
                const other = new DatabaseSync(database.path);
                try {
                  other
                    .prepare(
                      "UPDATE session_nodes SET entry_json = json_set(entry_json, ?, ?) WHERE session_key = ?",
                    )
                    .run("$.lifecycleRevision", "successor", scope.sessionKey);
                  // Keep row validity from masking the lifecycle-generation fence.
                  ensureSessionEntryValidityProjection(other);
                } finally {
                  other.close();
                }
              });
            } else if (race === "local-owner") {
              registerAgentRunContext("startup-race-owner", {
                sessionKey: scope.sessionKey,
                sessionId: "predecessor",
                projectSessionActive: false,
              });
            } else if (race === "session-admission") {
              admission = await beginSessionWorkAdmission({
                scope: database.path,
                identities: [scope.sessionKey, "predecessor"],
                assertAllowed: () => {},
              });
            } else if (race === "snapshot-lease-release") {
              openOpenClawStateDatabase()
                .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
                .run("gateway-owner", "global");
            } else if (race === "snapshot-lease-replace") {
              openOpenClawStateDatabase()
                .db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?")
                .run("replacement-owner", "gateway-owner", "global");
            } else {
              openOpenClawStateDatabase()
                .db.prepare(
                  "INSERT INTO subagent_runs(run_id,child_session_key,requester_session_key,created_at,payload_json) VALUES(?,?,?,?,?)",
                )
                .run("startup-race-owner", scope.sessionKey, "agent:main:main", Date.now(), "{}");
            }
            prepared = true;
            return settle(...args);
          },
        );
        const log = { info: vi.fn(), warn: vi.fn() };
        const runStartup = () =>
          runStartupSessionMaintenanceForTest({ cfg: { agents: { entries: { main: {} } } }, log });
        if (
          race === "snapshot-owner" ||
          race === "snapshot-lease-release" ||
          race === "snapshot-lease-replace"
        ) {
          openOpenClawStateDatabase();
          await withOpenClawStateDatabaseReadSnapshot(runStartup);
        } else {
          await runStartup();
        }
        expect(
          prepared,
          JSON.stringify({
            warnings: log.warn.mock.calls,
            info: log.info.mock.calls,
            current: accessor.loadSessionEntryReadOnly(scope),
          }),
        ).toBe(true);
        if (race === "durable-owner" || race === "snapshot-owner") {
          expect(log.warn).not.toHaveBeenCalled();
          expect(log.info).toHaveBeenCalledWith(
            "session: startup sessions: 0 interrupted, 0 archived settled, 1 retained by run/task owners",
          );
        } else {
          expect(log.warn).toHaveBeenCalled();
        }
        expect(
          (await accessor.loadTranscriptEvents({ ...scope, sessionId: "predecessor" })).filter(
            (event) => isRecord(event) && event.customType === "run-failed-before-reply",
          ),
        ).toEqual([]);
        const current = accessor.loadSessionEntryReadOnly(scope);
        expect(current).toEqual({
          ...original,
          ...(race === "session" ? { sessionId: "successor" } : {}),
          ...(race === "generation" ? { lifecycleRevision: "successor" } : {}),
          ...(race === "archive-state"
            ? { archivedAt: Math.floor(performance.timeOrigin) - 50 }
            : {}),
          ...(race === "restored-archive" ? { archivedAt: undefined } : {}),
        });
      },
      () => admission?.release(),
    );
  },
);

it.each(["owner", "durable-owner", "settlement", "receipt"] as const)(
  "settles the orphan and receipt atomically after a %s failure",
  async (failure) => {
    await withStartupGateway("startup-orphan-receipt-", async () => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:subagent:receipt",
        sessionId: "predecessor-receipt",
      };
      await accessor.replaceSessionEntry(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "predecessor-generation",
        delivery: normalizeSessionDeliveryState({
          context: { channel: "reef", accountId: "default", to: "reef:startup-orphan" },
        }),
        sessionDiffBaseline: {
          version: 1,
          sessionId: target.sessionId,
          root: "/synthetic",
          files: [],
        },
        status: "running",
        startedAt: Math.floor(performance.timeOrigin) - 100,
        updatedAt: Math.floor(performance.timeOrigin) - 100,
      });
      const original = accessor.loadSessionEntryReadOnly(target);
      const log = { info: vi.fn(), warn: vi.fn() };
      const databases = await prepareGatewayStartupSessions({
        cfg: { agents: { entries: { main: {} } } },
        log,
      });
      const runStartup = () => runGatewaySessionStartupMaintenance({ databases, log });
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      expect(
        database.db
          .prepare("SELECT session_id FROM session_conversations WHERE session_id = ?")
          .all(target.sessionId),
      ).toEqual([{ session_id: target.sessionId }]);
      let revoke: { mockRestore(): void } | undefined;
      let revoked = false;
      const ownerFailure = failure === "owner" || failure === "durable-owner";
      if (ownerFailure) {
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        revoke = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              const facts = request.facts;
              if (
                !revoked &&
                request.stage === "commit" &&
                isRecord(facts) &&
                isRecord(facts.identity) &&
                facts.identity.nativeLocation === database.path
              ) {
                revoked = true;
                if (failure === "owner") {
                  registerAgentRunContext("startup-race-owner", {
                    sessionKey: target.sessionKey,
                    sessionId: target.sessionId,
                    projectSessionActive: false,
                  });
                } else {
                  openOpenClawStateDatabase()
                    .db.prepare(
                      "INSERT INTO subagent_runs(run_id,child_session_key,requester_session_key,created_at,payload_json) VALUES(?,?,?,?,?)",
                    )
                    .run(
                      "startup-race-owner",
                      target.sessionKey,
                      "agent:main:main",
                      Date.now(),
                      "{}",
                    );
                }
              }
              admit(request, grant);
            }, attachment),
          );
      } else {
        // The companion write follows the interrupted row without changing canonical triggers.
        database.db.exec(
          failure === "receipt"
            ? "CREATE TRIGGER startup_fault BEFORE INSERT ON transcript_events BEGIN SELECT RAISE(ABORT, 'synthetic repair receipt write failure'); END"
            : "CREATE TRIGGER startup_fault BEFORE INSERT ON session_conversations WHEN EXISTS (SELECT 1 FROM session_nodes WHERE current_session_id = NEW.session_id AND json_extract(entry_json, '$.status') = 'interrupted') BEGIN SELECT RAISE(ABORT, 'synthetic settlement failure after interrupted row'); END",
        );
      }
      try {
        await runStartup();
      } finally {
        revoke?.mockRestore();
        if (!ownerFailure) {
          database.db.exec("DROP TRIGGER startup_fault");
        }
      }
      if (ownerFailure) {
        expect(revoked).toBe(true);
        if (failure === "durable-owner") {
          expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining("a retained run/task owns this session"),
          );
        }
      } else {
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            failure === "receipt"
              ? "synthetic repair receipt write failure"
              : "synthetic settlement failure after interrupted row",
          ),
        );
      }
      expect(accessor.loadSessionEntryReadOnly(target)).toEqual(original);
      expect(log.warn).toHaveBeenCalled();
      expect(
        (await accessor.loadTranscriptEvents(target)).filter(
          (event) => isRecord(event) && event.customType === "run-failed-before-reply",
        ),
      ).toEqual([]);
      clearAgentRunContext("startup-race-owner");
      if (failure === "durable-owner") {
        openOpenClawStateDatabase()
          .db.prepare("DELETE FROM subagent_runs WHERE run_id = ?")
          .run("startup-race-owner");
      }

      const publications: unknown[] = [];
      const unsubscribe = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === target.sessionKey) {
          publications.push(change);
        }
      });
      const repairObservedAt = Date.now();
      const observed = observeHostDataSql();
      try {
        await runStartup();
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
        unsubscribe();
      }
      expect(publications.length).toBeGreaterThan(0);
      const repaired = accessor.loadSessionEntryReadOnly(target);
      expect(repaired).toMatchObject({
        status: "interrupted",
        abortedLastRun: true,
        startedAt: original?.startedAt,
        updatedAt: original?.updatedAt,
        sessionDiffBaseline: original?.sessionDiffBaseline,
      });
      expect(repaired?.endedAt).toBeGreaterThanOrEqual(repairObservedAt);
      expect(repaired?.runtimeMs).toBeUndefined();
      const receipts = async () =>
        (await accessor.loadTranscriptEvents(target)).filter(
          (event) => isRecord(event) && event.customType === "run-failed-before-reply",
        );
      expect(await receipts()).toMatchObject([
        {
          display: true,
          details: {
            error: expect.stringContaining("interrupted before a terminal lifecycle event"),
          },
        },
      ]);
      await runStartup();
      expect(accessor.loadSessionEntryReadOnly(target)).toEqual(repaired);
      expect(await receipts()).toHaveLength(1);
    });
  },
);

it("keeps interrupted status distinct in canonical reads without inventing registry completion", async () => {
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: fs.realpathSync.native(roots.make("startup-orphan-status-")),
  };
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  for (const status of ["interrupted", "failed", "running"] as const) {
    await accessor.upsertSessionEntryCore(
      { agentId: "main", env, sessionKey: "agent:main:subagent:" + status },
      { sessionId: status, status, updatedAt: 10 },
    );
  }
  expect(
    readSessionEntriesByStatus(database, ["interrupted"]).map((row) => row.entry.status),
  ).toEqual(["interrupted"]);
  expect(readSessionEntriesByStatus(database, ["failed"]).map((row) => row.entry.status)).toEqual([
    "failed",
  ]);
  expect(readSessionEntriesByStatus(database, ["running"]).map((row) => row.entry.status)).toEqual([
    "running",
  ]);
  expect(
    resolveCompletionFromSessionEntry(
      { sessionId: "orphan", status: "interrupted", updatedAt: 10 },
      1000,
    ),
  ).toBeNull();
});
