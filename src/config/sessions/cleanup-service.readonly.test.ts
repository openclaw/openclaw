import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { listDirectoryTreeStrictSync } from "../../infra/directory-walk.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { afterCleanupRead } from "./cleanup-service.test-support.js";
import { replaceSessionEntrySync } from "./session-accessor.entry.js";
import { memorySessionActorOwners } from "./session-actor-memory-owner.js";
import { commitMemory } from "./session-actor-memory-publication.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

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
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
let stateDir: string;
let storePath: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-cleanup-readonly-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  maintenance.maxDiskBytes = maintenance.highWaterBytes = null;
});
const cleanup = (opts: Parameters<typeof runSessionsCleanup>[0]["opts"] = {}) =>
  runSessionsCleanup({ cfg: {}, opts, targets: [{ agentId: "main", storePath }] });
afterEach(() => {
  memorySessionActorOwners.reset();
  maintenance.mode = "enforce";
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each(["warn", "enforce"])(
  "does not materialize session payloads for a no-op cleanup in %s mode",
  async (mode) => {
    maintenance.mode = mode;
    for (let i = 0; i < 32; i++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:noop-${i}`, storePath },
        { sessionId: `noop-${i}`, updatedAt: Date.now() },
      );
    }
    let materializedEntries = 0;
    afterCleanupRead((snapshot) => {
      materializedEntries += Object.keys(snapshot.store).length;
    });
    const result = await cleanup();
    expect(result.appliedSummaries[0]).toMatchObject({
      beforeCount: 32,
      afterCount: 32,
      wouldMutate: false,
    });
    expect(materializedEntries).toBe(0);
  },
);

function withStateDatabase<T>(
  readOnly: boolean,
  run: (db: ReturnType<typeof openNodeSqliteDatabase>) => T,
) {
  const state = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(), { readOnly });
  try {
    return run(state);
  } finally {
    state.close();
  }
}
const readMetadata = (sqlitePath: string) =>
  withStateDatabase(true, (state) => ({
    registry: state.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path").all(),
    seal: fs.existsSync(`${sqlitePath}.seal`) ? fs.readFileSync(`${sqlitePath}.seal`) : undefined,
  }));

it.each([
  { name: "missing transcript preview", fixMissing: true, diskBudget: false },
  { name: "over-budget preview", fixMissing: false, diskBudget: true },
])(
  "keeps cold database contents and metadata unchanged during $name",
  async ({ fixMissing, diskBudget }) => {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:readonly", storePath },
      { sessionId: "readonly-session", updatedAt: Date.now() },
    );
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    revokeSqliteDatabaseAdmissionsForPath(sqlitePath);
    withStateDatabase(false, (state) => state.exec("UPDATE agent_databases SET last_seen_at = 1"));
    const metadata = readMetadata(sqlitePath);
    expect(metadata).toMatchObject({ registry: [expect.any(Object)], seal: undefined });
    const databaseBytes = fs.readFileSync(sqlitePath);
    maintenance.maxDiskBytes = diskBudget ? 1 : null;
    maintenance.highWaterBytes = diskBudget ? 1 : null;

    const result = await cleanup({ dryRun: true, fixMissing, enforce: true });

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
    storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    if (present) {
      const owner = memorySessionActorOwners.get({ agentId: "main", path: storePath });
      for (const id of ["empty", "live"]) {
        const sessionKey = `agent:main:dashboard:incognito-${id}`;
        const actor = await owner.acquire({ database: owner.identity, sessionKey }, lifetime);
        try {
          const entry = {
            sessionId: `incognito-${id}`,
            updatedAt: Date.now(),
            incognito: true,
          } satisfies SessionEntry;
          const message = {
            type: "message",
            id: "incognito-message",
            message: { role: "user", content: "Keep this memory-only turn." },
          };
          await commitMemory(
            actor.storage!,
            "session.entry.create",
            { entry, transcriptEvents: id === "live" ? [message] : [] },
            authority,
          );
        } finally {
          await actor.release();
        }
      }
    }
    const filesBefore = listDirectoryTreeStrictSync(stateDir).map(
      (walkEntry) => walkEntry.relativePath,
    );

    const result = await cleanup({ dryRun: true, fixMissing: true });

    const expected = {
      beforeCount: present ? 2 : 0,
      afterCount: present ? 1 : 0,
      missing: present ? 1 : 0,
    };
    expect(result.previewResults[0]?.summary).toMatchObject(expected);
    expect(result.appliedSummaries).toEqual([]);
    const observer = observeParentSqlite();
    try {
      const applied = await cleanup({ fixMissing: true, enforce: true });
      expect(applied.appliedSummaries[0]).toMatchObject({ ...expected, applied: true });
      const owner = memorySessionActorOwners.read({ agentId: "main", path: storePath });
      expect(
        owner?.listSessionEntries(authority).map(({ sessionKey }) => sessionKey) ?? [],
      ).toEqual(present ? ["agent:main:dashboard:incognito-live"] : []);
      if (!present) {
        expect(owner).toBeUndefined();
      }
      expect(observer.counts).toEqual(emptySqliteCounts());
    } finally {
      observer.restore();
    }
    expect(fs.existsSync(storePath)).toBe(false);
    expect(
      listDirectoryTreeStrictSync(stateDir).map((walkEntry) => walkEntry.relativePath),
    ).toEqual(filesBefore);
  },
);
