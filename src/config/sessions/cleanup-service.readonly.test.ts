import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import * as cleanupReads from "./cleanup-service-read.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { replaceSessionEntrySync } from "./session-accessor.entry.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const maintenance = vi.hoisted(() => ({
  mode: "enforce",
  pruneAfterMs: Number.MAX_SAFE_INTEGER,
  archiveDashboardAfterMs: null,
  modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
  maxEntries: 5000,
  preserveRecentMs: null,
  resetArchiveRetentionMs: null,
  maxDiskBytes: null as number | null,
  highWaterBytes: null as number | null,
}));
vi.mock("./store-maintenance-runtime.js", () => ({
  resolveMaintenanceConfig: () => maintenance,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  memorySessionActorOwners.reset();
  maintenance.mode = "enforce";
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each(["warn", "enforce"])(
  "does not materialize session payloads for a no-op cleanup in %s mode",
  async (mode) => {
    const stateDir = tempDirs.make("openclaw-cleanup-noop-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    maintenance.mode = mode;
    maintenance.maxDiskBytes = null;
    maintenance.highWaterBytes = null;
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    for (let i = 0; i < 32; i++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:noop-${i}`, storePath },
        { sessionId: `noop-${i}`, updatedAt: Date.now() },
      );
    }
    const withStore = cleanupReads.withSessionCleanupStore;
    let materializedEntries = 0;
    const readObserver = vi
      .spyOn(cleanupReads, "withSessionCleanupStore")
      .mockImplementation((target, consume, options) =>
        withStore(
          target,
          (owner) =>
            consume({
              ...owner,
              read: async (fixMissing) => {
                const snapshot = await owner.read(fixMissing);
                materializedEntries += Object.keys(snapshot.store).length;
                return snapshot;
              },
            }),
          options,
        ),
      );
    try {
      const result = await runSessionsCleanup({
        cfg: {},
        opts: {},
        targets: [{ agentId: "main", storePath }],
      });
      expect(result.appliedSummaries[0]).toMatchObject({
        beforeCount: 32,
        afterCount: 32,
        wouldMutate: false,
      });
      expect(materializedEntries).toBe(0);
    } finally {
      readObserver.mockRestore();
    }
  },
);

function readMetadata(sqlitePath: string) {
  const state = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(), { readOnly: true });
  try {
    return {
      registry: state.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path").all(),
      seal: fs.existsSync(`${sqlitePath}.seal`) ? fs.readFileSync(`${sqlitePath}.seal`) : undefined,
    };
  } finally {
    state.close();
  }
}

it.each([
  { name: "missing transcript preview", fixMissing: true, diskBudget: false },
  { name: "over-budget preview", fixMissing: false, diskBudget: true },
])(
  "keeps cold database contents and metadata unchanged during $name",
  async ({ fixMissing, diskBudget }) => {
    const stateDir = tempDirs.make("openclaw-cleanup-readonly-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    maintenance.maxDiskBytes = null;
    maintenance.highWaterBytes = null;
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:readonly", storePath },
      { sessionId: "readonly-session", updatedAt: Date.now() },
    );
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    revokeSqliteDatabaseAdmissionsForPath(sqlitePath);
    const state = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath());
    try {
      state.exec("UPDATE agent_databases SET last_seen_at = 1");
    } finally {
      state.close();
    }
    const metadata = readMetadata(sqlitePath);
    expect(metadata.registry).toHaveLength(1);
    expect(metadata.seal).toBeUndefined();
    const databaseBytes = fs.readFileSync(sqlitePath);
    maintenance.maxDiskBytes = diskBudget ? 1 : null;
    maintenance.highWaterBytes = diskBudget ? 1 : null;

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { dryRun: true, fixMissing, enforce: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(result.previewResults[0]?.summary).toMatchObject({
      beforeCount: 1,
      afterCount: fixMissing ? 0 : 1,
      missing: fixMissing ? 1 : 0,
      wouldMutate: fixMissing,
    });
    expect(result.appliedSummaries).toEqual([]);
    expect.soft(readMetadata(sqlitePath)).toEqual(metadata);
    expect(fs.readFileSync(sqlitePath)).toEqual(databaseBytes);
  },
);

it.each([false, true])(
  "previews and cleans an explicit memory store without SQLite (present=%s)",
  async (present) => {
    const stateDir = tempDirs.make("openclaw-cleanup-incognito-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    maintenance.maxDiskBytes = null;
    maintenance.highWaterBytes = null;
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    if (present) {
      const owner = memorySessionActorOwners.get({ agentId: "main", path: storePath });
      const authority = { assertCurrent() {}, authorize() {} };
      for (const id of ["empty", "live"]) {
        const actor = await owner.acquire(
          {
            database: owner.identity,
            sessionKey: `agent:main:dashboard:incognito-${id}`,
          },
          { assertCurrent() {}, assertReadable() {} },
        );
        try {
          expect(
            await actor.storage!.mutate(
              {
                type: "session.entry.create",
                input: {
                  entry: {
                    sessionId: `incognito-${id}`,
                    updatedAt: Date.now(),
                    incognito: true,
                  },
                  transcriptEvents:
                    id === "live"
                      ? [
                          {
                            type: "message",
                            id: "incognito-message",
                            message: {
                              role: "user",
                              content: [{ type: "text", text: "Keep this memory-only turn." }],
                            },
                          },
                        ]
                      : [],
                },
              },
              authority,
            ),
          ).toMatchObject({ kind: "committed" });
        } finally {
          await actor.release();
        }
      }
    }
    const filesBefore = fs.readdirSync(stateDir, { recursive: true });

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { dryRun: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(result.previewResults[0]?.summary).toMatchObject({
      beforeCount: present ? 2 : 0,
      afterCount: present ? 1 : 0,
      missing: present ? 1 : 0,
    });
    expect(result.appliedSummaries).toEqual([]);
    const observer = observeParentSqlite();
    try {
      const applied = await runSessionsCleanup({
        cfg: {},
        opts: { fixMissing: true, enforce: true },
        targets: [{ agentId: "main", storePath }],
      });
      expect(applied.appliedSummaries[0]).toMatchObject({
        beforeCount: present ? 2 : 0,
        afterCount: present ? 1 : 0,
        missing: present ? 1 : 0,
        applied: true,
      });
      const owner = memorySessionActorOwners.read({ agentId: "main", path: storePath });
      expect(
        owner
          ?.listSessionEntries({ assertCurrent() {}, authorize() {} })
          .map(({ sessionKey }) => sessionKey) ?? [],
      ).toEqual(present ? ["agent:main:dashboard:incognito-live"] : []);
      if (!present) {
        expect(owner).toBeUndefined();
      }
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
    }
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.readdirSync(stateDir, { recursive: true })).toEqual(filesBefore);
  },
);
