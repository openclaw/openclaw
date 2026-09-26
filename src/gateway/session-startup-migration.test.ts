/** SQLite startup maintenance without the unrelated full-Gateway fixture lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import {
  loadExactSessionEntry,
  loadExactSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as canonicalWorker from "../config/sessions/session-accessor.sqlite-canonical-worker-pool.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { withCanonicalSessionValidationDeferral } from "../config/sessions/session-canonical-validation-deferral.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import * as gatewayOwner from "../infra/gateway-owner-lease.js";
import * as stateOwner from "../infra/gateway-state-owner.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { hasPersistedOpenClawAgentCanonicalValidation } from "../state/openclaw-agent-canonical-validation-receipt.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runStartupSessionMigration } from "./server-startup-session-migration.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe("runStartupSessionMigration", () => {
  it.each([1, 2])(
    "admits the first session after certifying %i cold empty agent databases once",
    async (agentCount) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-small-startup-"));
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const agentIds = ["main", "secondary"].slice(0, agentCount);
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
        },
      };
      for (const agentId of agentIds) {
        openOpenClawAgentDatabase({ agentId, env });
      }
      const started = vi.spyOn(canonicalWorker, "startCanonicalValidationTask");
      try {
        for (let boot = 0; boot < 2; boot++) {
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest(stateDir);
          started.mockClear();
          const log = makeLog();
          await runStartupSessionMigration({ cfg, env, log });
          for (const agentId of agentIds) {
            const read = withCanonicalSessionValidationDeferral(() =>
              loadExactSessionEntryReadOnly({
                agentId,
                env,
                sessionKey: `agent:${agentId}:first-turn`,
              }),
            );
            expect(read).toEqual({ kind: "complete", value: undefined });
            expect(
              withOpenClawAgentDatabaseReadOnly(hasPersistedOpenClawAgentCanonicalValidation, {
                agentId,
                env,
              }),
            ).toMatchObject({ found: true, value: true });
          }
          expect(started.mock.calls.map(([, options]) => options.agentId).toSorted()).toEqual(
            boot === 0 ? agentIds : [],
          );
          expect(log.warn).not.toHaveBeenCalled();
        }
      } finally {
        started.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "keeps certified empty fleet maintenance read-only on both boots (Gateway owner=%s)",
    async (gatewayActive) => {
      const stateDir = tempDirs.make("openclaw-empty-fleet-startup-");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const agentIds = ["fleet-a", "fleet-b", "fleet-c", "fleet-d"];
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
        },
      };
      for (const agentId of agentIds) {
        openOpenClawAgentDatabase({ agentId, env });
      }
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawAgentDatabasesForTest();
      await runStartupSessionMigration({ cfg, env, log: makeLog() });
      const started = vi.spyOn(canonicalWorker, "startCanonicalValidationTask");
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const lifecycle = vi
        .spyOn(stateOwner, "hasActiveGatewayStateOwner")
        .mockReturnValue(gatewayActive);
      const lock = vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
        pid: process.pid,
        ownerId: "fleet-startup-owner",
        createdAt: new Date().toISOString(),
        port: 18789,
      });
      const owner = vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
        pid: process.pid,
        host: "fixture",
        startedAt: null,
        owner: "fleet-startup-owner",
        port: 18789,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });
      try {
        for (let boot = 0; boot < 2; boot++) {
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawAgentDatabasesForTest();
          open.mockClear();
          const log = makeLog();
          await runStartupSessionMigration({ cfg, env, log });
          expect(started).not.toHaveBeenCalled();
          expect(log.warn).not.toHaveBeenCalled();
          expect(
            open.mock.calls.filter(
              ([pathname, behavior]) =>
                typeof pathname === "string" &&
                pathname.endsWith("openclaw-agent.sqlite") &&
                behavior?.readOnly !== true,
            ),
          ).toEqual([]);
        }
      } finally {
        started.mockRestore();
        open.mockRestore();
        lifecycle.mockRestore();
        lock.mockRestore();
        owner.mockRestore();
      }
    },
  );

  it.each(["successful", "failed"] as const)(
    "hands the cold maintenance connection directly to %s reconciliation",
    async (outcome) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-startup-handoff-"));
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const options = { agentId: "main", env };
      const initial = openOpenClawAgentDatabase(options);
      setCanonicalSqliteSessionMainKey(initial, "previous");
      await closeOpenClawAgentDatabasesAsync(stateDir);
      closeOpenClawAgentDatabasesForTest(stateDir);
      const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      let handedOff: ReturnType<typeof getOpenClawAgentDatabaseIfOpen>;
      let reconciled: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
      const failure = new Error("projection reconciliation failed");
      const reconcileSessionTranscriptIndexes = vi.fn(
        async (databaseOptions: OpenClawAgentDatabaseOptions) => {
          handedOff = getOpenClawAgentDatabaseIfOpen(databaseOptions);
          reconciled = openOpenClawAgentDatabase(databaseOptions);
          if (outcome === "failed") {
            throw failure;
          }
          return { reconciledSessions: 0 };
        },
      );
      try {
        const startup = runStartupSessionMigration({
          cfg: { agents: { entries: { main: {} } } },
          env,
          log: makeLog(),
          deps: { reconcileSessionTranscriptIndexes },
        });
        if (outcome === "failed") {
          await expect(startup).rejects.toBe(failure);
        } else {
          await startup;
        }
        expect(reconcileSessionTranscriptIndexes).toHaveBeenCalledOnce();
        expect(handedOff).toBe(reconciled);
        expect(
          open.mock.calls.filter(
            ([databasePath, behavior]) =>
              databasePath === initial.path && behavior?.readOnly !== true,
          ),
        ).toHaveLength(1);
        expect(isOpenClawAgentDatabaseOpen(initial.path)).toBe(outcome === "successful");
      } finally {
        open.mockRestore();
      }
    },
  );

  it("does not create databases for agents without durable sessions", async () => {
    const stateDir = tempDirs.make("openclaw-empty-session-startup-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const reconcileSessionTranscriptIndexes = vi.fn(async () => ({ reconciledSessions: 0 }));
    await runStartupSessionMigration({
      cfg: { agents: { entries: { main: {}, ops: {} } } },
      env,
      log: makeLog(),
      deps: { reconcileSessionTranscriptIndexes },
    });
    expect(reconcileSessionTranscriptIndexes).not.toHaveBeenCalled();
    for (const agentId of ["main", "ops"]) {
      expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
    }
  });

  it.each(["default", "custom", "shared", "scoped"] as const)(
    "repairs transcript projections in the %s SQLite store before serving history",
    async (layout) => {
      const root = fs.realpathSync.native(tempDirs.make("openclaw-sqlite-session-startup-"));
      const stateDir = path.join(root, "state");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const env = { ...process.env };
        const agentId = "qa";
        const storePath =
          layout === "default" || layout === "scoped"
            ? undefined
            : path.join(root, "custom", layout === "shared" ? "shared.sqlite" : "sessions.json");
        const cfg: OpenClawConfig = {
          agents: {
            ownership: "explicit",
            entries: { qa: {}, ...(layout === "scoped" ? { main: {} } : {}) },
          },
          ...(storePath ? { session: { store: storePath } } : {}),
        };
        const scope = {
          agentId,
          defaultAgentId: "main",
          env,
          sessionId: "startup-session",
          sessionKey: "agent:qa:startup",
          storePath,
        };
        await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
        await persistSessionTranscriptTurn(scope, {
          messages: [
            { eventId: "startup-message", message: { role: "user", content: "retained history" } },
          ],
          touchSessionEntry: false,
        });
        const options = toDatabaseOptions(resolveSqliteReadScope(scope));
        await waitForSessionTranscriptIndexReconcile(options);
        const database = openOpenClawAgentDatabase(options);
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
        expect(sessionTranscriptIndexNeedsReconcile(database.db, scope.sessionId)).toBe(true);
        const peerScope = {
          ...scope,
          agentId: "main",
          sessionId: "peer-session",
          sessionKey: "agent:main:peer",
        };
        const peerOptions = { agentId: "main", env };
        if (layout === "scoped") {
          await upsertSessionEntryCore(peerScope, {
            sessionId: peerScope.sessionId,
            updatedAt: 10,
          });
          await persistSessionTranscriptTurn(peerScope, {
            messages: [
              { eventId: "peer-message", message: { role: "user", content: "peer history" } },
            ],
            touchSessionEntry: false,
          });
          await waitForSessionTranscriptIndexReconcile(peerOptions);
          openOpenClawAgentDatabase(peerOptions)
            .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1")
            .run();
        }
        await closeOpenClawAgentDatabasesAsync(root);
        closeOpenClawAgentDatabasesForTest(root);
        const log = makeLog();

        await runStartupSessionMigration({
          cfg,
          env,
          log,
          ...(layout === "scoped" ? { agentIds: new Set([agentId]) } : {}),
        });

        const reopened = openOpenClawAgentDatabase(options);
        expect(sessionTranscriptIndexNeedsReconcile(reopened.db, scope.sessionId)).toBe(false);
        expect(loadExactSessionEntry(scope)?.entry.sessionId).toBe(scope.sessionId);
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info).toHaveBeenCalledWith(
          "session: rebuilt 1 transcript projection(s) before serving history",
        );
        if (layout === "shared") {
          expect(reopened.agentId).toBe("main");
          expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
        }
        if (layout === "scoped") {
          expect(
            sessionTranscriptIndexNeedsReconcile(
              openOpenClawAgentDatabase(peerOptions).db,
              peerScope.sessionId,
            ),
          ).toBe(true);
        }
        expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);
      });
    },
  );

  it.each(["configured", "retired-root"] as const)(
    "preserves the %s legacy source and requires explicit Doctor import",
    async (layout) => {
      const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-legacy-session-startup-"));
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "migration" };
      const storePath =
        layout === "configured"
          ? path.join(stateDir, "custom", "sessions.json")
          : path.join(stateDir, "sessions", "sessions.json");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        ...(layout === "configured" ? { session: { store: storePath } } : {}),
      };
      const original = JSON.stringify({
        "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 },
      });
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, original);

      await expect(runStartupSessionMigration({ cfg, env, log: makeLog() })).rejects.toThrow(
        "openclaw --profile migration doctor --fix",
      );
      expect(fs.readFileSync(storePath, "utf8")).toBe(original);
      expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);

      const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
      expect(imported.totals.importedEntries).toBe(1);
      expect(imported.totals.archivedLegacyStoreFiles).toBe(1);
      await expect(
        runStartupSessionMigration({ cfg, env, log: makeLog() }),
      ).resolves.toBeUndefined();
    },
  );
});
