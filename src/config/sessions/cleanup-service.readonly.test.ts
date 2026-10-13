import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { clearOpenClawAgentIntegrityVerification } from "../../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  resolveOpenClawStateSqlitePath,
  resolveQuarantineStorePath,
} from "../../state/openclaw-state-db.paths.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { replaceSessionEntrySync } from "./session-accessor.entry.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
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
  maintenance.mode = "enforce";
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it.each(["warn", "enforce"])(
  "does not materialize session payloads for a no-op cleanup in %s mode",
  async (mode) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-cleanup-noop-"));
    maintenance.mode = mode;
    maintenance.maxDiskBytes = null;
    maintenance.highWaterBytes = null;
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    for (let i = 0; i < 32; i++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:noop-${i}`, storePath },
        { sessionId: `noop-${i}`, updatedAt: Date.now(), incognito: true },
      );
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    const reads = trackSqliteStatementExecutions(database.db, ["payload"], (sql) =>
      /\b(?:session_nodes|session_entry_snapshots)\b/i.test(sql) && /\bentry_json\b/i.test(sql)
        ? "payload"
        : null,
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
      expect(reads.textBytes.payload).toBe(0);
    } finally {
      reads.restore();
    }
  },
);

function readMetadata() {
  const state = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(), { readOnly: true });
  const quarantine = openNodeSqliteDatabase(resolveQuarantineStorePath(process.env), {
    readOnly: true,
  });
  try {
    return {
      registry: state.prepare("SELECT * FROM agent_databases ORDER BY agent_id, path").all(),
      integrity: quarantine
        .prepare("SELECT * FROM agent_integrity_verifications ORDER BY path")
        .all(),
    };
  } finally {
    quarantine.close();
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
    clearOpenClawAgentIntegrityVerification(sqlitePath, process.env);
    const state = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath());
    try {
      state.exec("UPDATE agent_databases SET last_seen_at = 1");
    } finally {
      state.close();
    }
    const metadata = readMetadata();
    expect(metadata.registry).toHaveLength(1);
    expect(metadata.integrity).toEqual([]);
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
    expect.soft(readMetadata()).toEqual(metadata);
    expect(fs.readFileSync(sqlitePath)).toEqual(databaseBytes);
  },
);

it.each([false, true])(
  "previews an explicit process-held store without creating disk state (present=%s)",
  async (present) => {
    const stateDir = tempDirs.make("openclaw-cleanup-incognito-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    maintenance.maxDiskBytes = null;
    maintenance.highWaterBytes = null;
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    if (present) {
      for (const id of ["empty", "live"]) {
        const scope = {
          agentId: "main",
          sessionKey: `agent:main:dashboard:incognito-${id}`,
          sessionId: `incognito-${id}`,
          storePath,
        };
        replaceSessionEntrySync(scope, {
          sessionId: scope.sessionId,
          updatedAt: Date.now(),
          incognito: true,
        });
        if (id === "live") {
          appendTranscriptMessageSync(scope, {
            eventId: "incognito-message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Keep this memory-only turn." }],
            },
          });
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
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.readdirSync(stateDir, { recursive: true })).toEqual(filesBefore);
  },
);
