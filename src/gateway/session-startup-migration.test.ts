/** SQLite startup maintenance without the unrelated full-Gateway fixture lifecycle. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runDoctorSessionSqlite } from "../commands/doctor-session-sqlite.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  loadExactSessionEntryReadOnly,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import * as transcriptReconcile from "../config/sessions/session-transcript-reconcile.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { hasPersistedOpenClawAgentCanonicalValidation } from "../state/openclaw-agent-canonical-validation-receipt.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "../state/openclaw-agent-db-lease.js";
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
import {
  prepareGatewayStartupSessions,
  runGatewaySessionStartupMaintenance,
} from "./server-startup-session-migration.js";
import { runStartupSessionMaintenanceForTest } from "./server-startup-session-migration.test-support.js";
import { readSessionMessagesPageWithStatsAsync } from "./session-transcript-readers.js";

const tempDirs = createTempDirTracker();

async function closeAgentDatabases(root?: string) {
  await closeOpenClawAgentDatabasesAsync(root);
  closeOpenClawAgentDatabasesForTest(root);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeAgentDatabases();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  tempDirs.cleanup();
});

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

function fleetConfig(agentIds: string[]): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
  };
}

function fleetFixture(agentIds: string[]) {
  const stateDir = fs.realpathSync.native(tempDirs.make("session-startup-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  for (const agentId of agentIds) {
    openOpenClawAgentDatabase({ agentId, env });
  }
  return { stateDir, env, cfg: fleetConfig(agentIds) };
}

function needsReconcile(options: OpenClawAgentDatabaseOptions, sessionId: string) {
  return sessionTranscriptIndexNeedsReconcile(openOpenClawAgentDatabase(options).db, sessionId);
}

async function seedHistory(
  scope: Parameters<typeof upsertSessionEntryCore>[0] & { sessionId: string },
  eventId: string,
  content: string,
) {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  await persistSessionTranscriptTurn(scope, {
    messages: [{ eventId, message: { role: "user", content } }],
    touchSessionEntry: false,
  });
  const options = toDatabaseOptions(resolveSqliteReadScope(scope));
  await waitForSessionTranscriptIndexReconcile(options);
  openOpenClawAgentDatabase(options)
    .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
    .run(scope.sessionId);
  return options;
}

describe("runStartupSessionMaintenanceForTest", () => {
  it("certifies a cold empty fleet then keeps both restarts read-only", async () => {
    const agentIds = ["fleet-a", "fleet-b", "fleet-c", "fleet-d"];
    const { env, cfg } = fleetFixture(agentIds);
    await closeAgentDatabases();
    for (const agentId of agentIds) {
      invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(
        resolveOpenClawAgentSqlitePath({ agentId, env }),
      );
    }
    const coldLog = makeLog();
    await runStartupSessionMaintenanceForTest({ cfg, env, log: coldLog });
    expect(coldLog.warn).not.toHaveBeenCalled();
    const open = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
    for (let boot = 0; boot < 2; boot++) {
      await closeAgentDatabases();
      open.mockClear();
      const log = makeLog();
      await runStartupSessionMaintenanceForTest({ cfg, env, log });
      for (const agentId of agentIds) {
        const scope = { agentId, env };
        expect(
          loadExactSessionEntryReadOnly({ ...scope, sessionKey: `agent:${agentId}:first-turn` }),
        ).toBeUndefined();
        expect(
          withOpenClawAgentDatabaseReadOnly(hasPersistedOpenClawAgentCanonicalValidation, scope),
        ).toMatchObject({ found: true, value: true });
      }
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
  });

  it("hands the cold maintenance connection directly to failed reconciliation", async () => {
    const { stateDir, env } = fleetFixture(["main"]);
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const options = { agentId: "main", env };
    const initial = openOpenClawAgentDatabase(options);
    setCanonicalSqliteSessionMainKey(initial, "previous");
    await closeAgentDatabases(stateDir);
    let handedOff: ReturnType<typeof getOpenClawAgentDatabaseIfOpen>;
    let reconciled: ReturnType<typeof openOpenClawAgentDatabase> | undefined;
    const failure = new Error("projection reconciliation failed");
    vi.spyOn(transcriptReconcile, "reconcileSessionTranscriptIndexes").mockImplementation(
      async (databaseOptions: OpenClawAgentDatabaseOptions) => {
        handedOff = getOpenClawAgentDatabaseIfOpen(databaseOptions);
        reconciled = openOpenClawAgentDatabase(databaseOptions);
        throw failure;
      },
    );
    const startup = runStartupSessionMaintenanceForTest({ cfg, env, log: makeLog() });
    await expect(startup).rejects.toBe(failure);
    expect(handedOff).toBe(reconciled);
    expect(isOpenClawAgentDatabaseOpen(initial.path)).toBe(true);
  });

  it("does not repair a physical successor through the startup target inventory", async () => {
    const stateDir = tempDirs.make("startup-maintenance-generation-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const options = { agentId: "main", env };
    const original = openOpenClawAgentDatabase(options);
    const databases = await prepareGatewayStartupSessions({
      cfg,
      env,
      log: makeLog(),
    });
    await closeOpenClawAgentDatabasesAsync(stateDir);
    fs.renameSync(original.path, `${original.path}.retired`);
    const successor = openOpenClawAgentDatabase(options);
    const reconcileSessionTranscriptIndexes = vi
      .spyOn(transcriptReconcile, "reconcileSessionTranscriptIndexes")
      .mockResolvedValue({ reconciledSessions: 0 });
    await expect(
      runGatewaySessionStartupMaintenance({ databases, log: makeLog() }),
    ).rejects.toThrow("identity changed");
    expect(reconcileSessionTranscriptIndexes).not.toHaveBeenCalled();
    expect(successor.db.isOpen).toBe(true);
  });

  it.each(["default", "shared", "scoped"] as const)(
    "admits the %s SQLite store before repair and preserves its history",
    async (layout) => {
      const root = fs.realpathSync.native(tempDirs.make("openclaw-sqlite-session-startup-"));
      const stateDir = path.join(root, "state");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const env = { ...process.env };
        const agentId = "qa";
        const storePath =
          layout === "shared" ? path.join(root, "custom", "shared.sqlite") : undefined;
        const cfg: OpenClawConfig = {
          ...fleetConfig(layout === "scoped" ? ["qa", "main"] : ["qa"]),
          ...(storePath ? { session: { store: storePath } } : {}),
        };
        setRuntimeConfigSnapshot(cfg);
        const scope = {
          agentId,
          defaultAgentId: "main",
          env,
          sessionId: "startup-session",
          sessionKey: "agent:qa:startup",
          storePath,
        };
        const options = await seedHistory(scope, "startup-message", "retained history");
        expect(needsReconcile(options, scope.sessionId)).toBe(true);
        const peerScope = {
          ...scope,
          agentId: "main",
          sessionId: "peer-session",
          sessionKey: "agent:main:peer",
        };
        const peerOptions = { agentId: "main", env };
        if (layout === "scoped") {
          await seedHistory(peerScope, "peer-message", "peer history");
        }
        await closeAgentDatabases(root);
        const log = makeLog();

        const databases = await prepareGatewayStartupSessions({
          cfg,
          env,
          log,
          ...(layout === "scoped" ? { agentIds: new Set([agentId]) } : {}),
        });
        expect(needsReconcile(options, scope.sessionId)).toBe(true);
        expect(loadExactSessionEntry(scope)?.entry.sessionId).toBe(scope.sessionId);
        await runGatewaySessionStartupMaintenance({ databases, log });

        const reopened = openOpenClawAgentDatabase(options);
        expect(sessionTranscriptIndexNeedsReconcile(reopened.db, scope.sessionId)).toBe(false);
        const history = await readSessionMessagesPageWithStatsAsync(scope, {
          maxMessages: 10,
          offset: 0,
        });
        expect(history.messages).toEqual([
          expect.objectContaining({ role: "user", content: "retained history" }),
        ]);
        expect(loadExactSessionEntry(scope)?.entry.sessionId).toBe(scope.sessionId);
        expect(log.warn).not.toHaveBeenCalled();
        if (layout === "shared") {
          expect(reopened.agentId).toBe("main");
          expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId, env }))).toBe(false);
        }
        if (layout === "scoped") {
          expect(needsReconcile(peerOptions, peerScope.sessionId)).toBe(true);
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
    const original = JSON.stringify({
      "agent:main:legacy": { sessionId: "legacy-session", updatedAt: 1 },
    });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, original);

    await expect(
      runStartupSessionMaintenanceForTest({ cfg, env, log: makeLog() }),
    ).resolves.toBeUndefined();
    cfg.session = { store: storePath };
    await expect(runStartupSessionMaintenanceForTest({ cfg, env, log: makeLog() })).rejects.toThrow(
      "openclaw --profile migration doctor --fix",
    );
    expect(fs.readFileSync(storePath, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(stateDir, "session-sqlite-migration-runs"))).toBe(false);

    const imported = await runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
    expect(imported.totals).toMatchObject({ importedEntries: 1, archivedLegacyStoreFiles: 1 });
    await expect(
      runStartupSessionMaintenanceForTest({ cfg, env, log: makeLog() }),
    ).resolves.toBeUndefined();
  });
});
