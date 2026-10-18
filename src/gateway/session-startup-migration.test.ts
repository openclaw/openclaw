import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntry as loadEntry,
  loadExactSessionEntryReadOnly as readEntry,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as canonicalWorker from "../config/sessions/session-accessor.sqlite-canonical-worker-pool.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { sessionTranscriptIndexNeedsReconcile as indexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gatewayLock from "../infra/gateway-lock.js";
import * as gatewayOwner from "../infra/gateway-owner-lease.js";
import * as stateOwner from "../infra/gateway-state-owner.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { hasPersistedOpenClawAgentCanonicalValidation as hasValidation } from "../state/openclaw-agent-canonical-validation-receipt.js";
import { withOpenClawAgentDatabaseReadOnly as readDatabase } from "../state/openclaw-agent-db-readonly.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions as AgentDbOptions,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  prepareGatewayStartupSessions,
  runGatewaySessionStartupMaintenance,
} from "./server-startup-session-migration.js";
import { runStartupSessionMaintenanceForTest as startup } from "./server-startup-session-migration.test-support.js";
import { readSessionMessagesPageWithStatsAsync as readMessages } from "./session-transcript-readers.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAgents();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
});

const makeLog = () => ({ info: vi.fn(), warn: vi.fn() });

function startupOptions(
  env: NodeJS.ProcessEnv,
  cfg: OpenClawConfig = { agents: { entries: { main: {} } } },
) {
  return { env, cfg, log: makeLog() };
}

async function closeAgents(stateDir?: string) {
  await closeOpenClawAgentDatabasesAsync(stateDir);
  closeOpenClawAgentDatabasesForTest(stateDir);
}

function needsReconcile(options: AgentDbOptions, sessionId: string) {
  return indexNeedsReconcile(openOpenClawAgentDatabase(options).db, sessionId);
}

function isolatedState(prefix: string) {
  const stateDir = fs.realpathSync.native(tempDirs.make(prefix));
  return { stateDir, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function historyScope(agentId: string, env: NodeJS.ProcessEnv, storePath?: string) {
  return {
    agentId,
    env,
    storePath,
    defaultAgentId: "main",
    sessionId: `${agentId}-session`,
    sessionKey: `agent:${agentId}:startup`,
  };
}

async function seedHistory(scope: ReturnType<typeof historyScope>, content: string) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  await persistSessionTranscriptTurn(scope, {
    messages: [{ eventId: scope.sessionId, message: { role: "user", content } }],
    touchSessionEntry: false,
  });
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  await waitForSessionTranscriptIndexReconcile(options);
  openOpenClawAgentDatabase(options)
    .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
  return options;
}

it.each([false, true])(
  "certifies cold stores once and keeps warm boots read-only (owner=%s)",
  async (gatewayActive) => {
    const agentIds = ["fleet-c", "fleet-d", "main", "secondary"];
    const { stateDir, env } = isolatedState("openclaw-empty-fleet-startup-");
    const entries = Object.fromEntries(agentIds.map((id) => [id, {}]));
    const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries } };
    for (const agentId of agentIds) {
      openOpenClawAgentDatabase({ agentId, env });
    }
    const started = vi.spyOn(canonicalWorker, "startCanonicalValidationTask");
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    for (let boot = 0; boot < 4; boot++) {
      await closeAgents(stateDir);
      if (boot === 0) {
        for (const agentId of agentIds) {
          revokeSqliteDatabaseAdmissionsForPath(resolveOpenClawAgentSqlitePath({ agentId, env }));
        }
      }
      started.mockClear();
      open.mockClear();
      const log = makeLog();
      await startup({ cfg, env, log });
      for (const agentId of agentIds) {
        const scope = { agentId, env, sessionKey: `agent:${agentId}:first-turn` };
        expect(readEntry(scope)).toBeUndefined();
        expect(readDatabase(hasValidation, scope)).toMatchObject({ found: true, value: true });
      }
      expect(started.mock.calls.map(([, options]) => options.agentId).toSorted()).toEqual(
        boot === 0 ? agentIds : [],
      );
      expect(log.warn).not.toHaveBeenCalled();
      if (boot > 1) {
        expect(
          open.mock.calls.filter(
            ([file, mode]) =>
              typeof file === "string" &&
              file.endsWith("openclaw-agent.sqlite") &&
              mode?.readOnly !== true,
          ),
        ).toEqual([]);
      } else if (boot === 1) {
        const owner = { pid: process.pid, port: 18789 };
        vi.spyOn(stateOwner, "hasActiveGatewayStateOwner").mockReturnValue(gatewayActive);
        vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
          ...owner,
          ownerId: "fleet-startup-owner",
          createdAt: new Date().toISOString(),
        });
        vi.spyOn(gatewayOwner, "readGatewayOwnerLease").mockReturnValue({
          ...owner,
          host: "fixture",
          startedAt: null,
          owner: "fleet-startup-owner",
          mode: "foreground",
          supervisor: null,
          state: "live",
          expired: false,
        });
      }
    }
  },
);

it("hands the cold maintenance connection directly to failed reconciliation", async () => {
  const { stateDir, env } = isolatedState("openclaw-startup-handoff-");
  const options = { agentId: "main", env };
  const initial = openOpenClawAgentDatabase(options);
  setCanonicalSqliteSessionMainKey(initial, "previous");
  await closeAgents(stateDir);
  const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
  let handedOff: ReturnType<typeof getOpenClawAgentDatabaseIfOpen>;
  let reconciled: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
  const failure = new Error("projection reconciliation failed");
  const reconcileSessionTranscriptIndexes = vi.fn(async (databaseOptions: AgentDbOptions) => {
    handedOff = getOpenClawAgentDatabaseIfOpen(databaseOptions);
    reconciled = openOpenClawAgentDatabase(databaseOptions);
    throw failure;
  });
  const maintenance = startup({
    ...startupOptions(env),
    deps: { reconcileSessionTranscriptIndexes },
  });
  await expect(maintenance).rejects.toBe(failure);
  expect(reconcileSessionTranscriptIndexes).toHaveBeenCalledOnce();
  expect(handedOff).toBe(reconciled);
  expect(
    open.mock.calls.filter(
      ([databasePath, behavior]) => databasePath === initial.path && behavior?.readOnly !== true,
    ),
  ).toHaveLength(1);
  expect(isOpenClawAgentDatabaseOpen(initial.path)).toBe(true);
});

it("does not repair a physical successor through the startup target inventory", async () => {
  const { stateDir, env } = isolatedState("startup-maintenance-generation-");
  const options = { agentId: "main", env };
  const original = openOpenClawAgentDatabase(options);
  const databases = await prepareGatewayStartupSessions(startupOptions(env));
  await closeOpenClawAgentDatabasesAsync(stateDir);
  fs.renameSync(original.path, `${original.path}.retired`);
  const successor = openOpenClawAgentDatabase(options);
  const reconcileSessionTranscriptIndexes = vi.fn(async () => ({ reconciledSessions: 0 }));
  await expect(
    runGatewaySessionStartupMaintenance({
      databases,
      log: makeLog(),
      deps: { reconcileSessionTranscriptIndexes },
    }),
  ).rejects.toThrow("identity changed");
  expect(reconcileSessionTranscriptIndexes).not.toHaveBeenCalled();
  expect(successor.db.isOpen).toBe(true);
});

it("does not create databases for agents without durable sessions", async () => {
  const stateDir = tempDirs.make("openclaw-empty-session-startup-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const reconcileSessionTranscriptIndexes = vi.fn(async () => ({ reconciledSessions: 0 }));
  await startup({
    ...startupOptions(env, { agents: { entries: { main: {}, ops: {} } } }),
    deps: { reconcileSessionTranscriptIndexes },
  });
  expect(reconcileSessionTranscriptIndexes).not.toHaveBeenCalled();
  for (const agentId of ["main", "ops"]) {
    expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
  }
});

it.each(["default", "shared", "scoped"] as const)(
  "admits the %s SQLite store before repair and preserves its history",
  async (layout) => {
    const root = fs.realpathSync.native(tempDirs.make("openclaw-sqlite-session-startup-"));
    const stateDir = path.join(root, "state");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const env = { ...process.env };
      const agentId = "qa";
      const storePath = layout === "shared" ? path.join(root, "custom/shared.sqlite") : undefined;
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { qa: {}, ...(layout === "scoped" ? { main: {} } : {}) },
        },
        ...(storePath ? { session: { store: storePath } } : {}),
      };
      setRuntimeConfigSnapshot(cfg);
      const scope = historyScope(agentId, env, storePath);
      const options = await seedHistory(scope, "retained history");
      expect(needsReconcile(options, scope.sessionId)).toBe(true);
      const peerScope = historyScope("main", env, storePath);
      if (layout === "scoped") {
        await seedHistory(peerScope, "peer history");
      }
      await closeAgents(root);
      const log = makeLog();

      const databases = await prepareGatewayStartupSessions({
        cfg,
        env,
        log,
        ...(layout === "scoped" ? { agentIds: new Set([agentId]) } : {}),
      });
      expect(needsReconcile(options, scope.sessionId)).toBe(true);
      expect(loadEntry(scope)?.entry.sessionId).toBe(scope.sessionId);
      await runGatewaySessionStartupMaintenance({ databases, log });

      const reopened = openOpenClawAgentDatabase(options);
      expect(needsReconcile(options, scope.sessionId)).toBe(false);
      const history = await readMessages(scope, { maxMessages: 10, offset: 0 });
      expect(history.messages).toEqual([
        expect.objectContaining({ role: "user", content: "retained history" }),
      ]);
      expect(loadEntry(scope)?.entry.sessionId).toBe(scope.sessionId);
      expect(log.warn).not.toHaveBeenCalled();
      if (layout !== "default") {
        expect(log.info).toHaveBeenCalledWith("session: rebuilt 1 transcript projection(s)");
      }
      if (layout === "shared") {
        expect(reopened.agentId).toBe("main");
        expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
      }
      if (layout === "scoped") {
        expect(needsReconcile({ agentId: "main", env }, peerScope.sessionId)).toBe(true);
      }
      expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);
    });
  },
);

it("preserves the retired-root legacy source until a configured Doctor import", async () => {
  const stateDir = fs.realpathSync.native(tempDirs.make("openclaw-legacy-session-startup-"));
  const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_PROFILE: "migration" };
  const storePath = path.join(stateDir, "sessions", "sessions.json");
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const key = "agent:main:legacy";
  const original = JSON.stringify({ [key]: { sessionId: "legacy-session", updatedAt: 1 } });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, original);

  await expect(startup(startupOptions(env, cfg))).resolves.toBeUndefined();
  cfg.session = { store: storePath };
  await expect(startup(startupOptions(env, cfg))).rejects.toThrow(
    "openclaw --profile migration doctor --fix",
  );
  expect(fs.readFileSync(storePath, "utf8")).toBe(original);
  expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);

  const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
  expect(imported.totals).toMatchObject({ importedEntries: 1, archivedLegacyStoreFiles: 1 });
  await expect(startup(startupOptions(env, cfg))).resolves.toBeUndefined();
});
