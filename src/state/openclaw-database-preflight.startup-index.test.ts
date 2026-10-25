import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayStartupFailureExitCode } from "../cli/gateway-cli/startup-maintenance.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { activateGatewayAgentDatabaseStartup } from "../gateway/server-agent-database-startup.js";
import { prepareGatewayStartupSessions } from "../gateway/server-startup-session-migration.js";
import {
  readSqliteDatabaseCleanClose,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import {
  corruptSqliteIndexKey,
  installSqliteFtsTokenizerMismatch,
} from "../infra/sqlite-index-corruption.test-support.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import {
  createAgentDatabaseAdmissionErrorShape,
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  databaseFixture,
  agentConfig,
  openRawDatabase,
} from "./database-preflight-fixtures.test-support.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repairMessage = "Rebuilt canonical agent SQLite indexes";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  await flushLogger();
  clearRuntimeConfigSnapshot();
  setLoggerOverride(null);
  resetLogger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createFixture(
  ids: string[],
  damage?: "missing" | "drifted" | "missing table",
  sessionId = (id: string) => `${id}-history`,
) {
  const stateDir = fs.realpathSync.native(tempDirs.make("startup-index-"));
  const base = databaseFixture(stateDir, process.env);
  const { env } = base;
  const logPath = path.join(stateDir, "startup.log");
  const configPath = path.join(stateDir, "openclaw.json");
  const config = {
    // Keep unrelated age-based reclamation from reopening writers during fixture shutdown.
    session: { maintenance: { mode: "warn" as const } },
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(ids.map((id) => [id, {}] as const)),
    },
  };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "warn");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...config, logging: { level: "warn", file: logPath } }),
  );
  setRuntimeConfigSnapshot(config);
  setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
  const agents: Array<{
    agentId: string;
    path: string;
    session: { agentId: string; env: typeof env; sessionKey: string };
    entry: Awaited<ReturnType<typeof replaceSessionEntry>>;
  }> = [];
  for (const agentId of ids) {
    const session = { agentId, env, sessionKey: `agent:${agentId}:retained` };
    const entry = await replaceSessionEntry(session, {
      sessionId: sessionId(agentId),
      updatedAt: 1,
    });
    expect(entry).not.toBeNull();
    agents.push({ agentId, path: resolveOpenClawAgentSqlitePath(session), session, entry });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  for (const agent of damage ? agents : []) {
    const writer = openRawDatabase(agent.path);
    writer.exec(
      "DROP INDEX idx_agent_session_nodes_active; UPDATE schema_meta SET app_version = '2026.9.1';",
    );
    if (damage === "drifted") {
      writer.exec("CREATE INDEX idx_agent_session_nodes_active ON session_nodes(session_key);");
    } else if (damage === "missing table") {
      writer.exec("DROP TABLE session_key_contract;");
    }
    writer.close();
    retireSqliteDatabaseAdmissionForPath(agent.path);
  }
  const bytes = () => agents.map((agent) => fs.readFileSync(agent.path));
  return {
    ...base,
    config,
    agents,
    logPath,
    bytes,
    before: bytes(),
    ready: (
      cfg: Parameters<typeof base.ready>[0] = config,
      operation: "gateway-startup" | "gateway-restart" = "gateway-startup",
    ) => base.ready(cfg, operation),
    prepare: () =>
      prepareGatewayStartupSessions({ cfg: config, env, log: { info: vi.fn(), warn: vi.fn() } }),
  };
}

function activateStartup(
  admission: Parameters<Parameters<typeof withAgentDatabaseStartupAdmission>[0]>[0],
  config: OpenClawConfig,
) {
  const activate = admission.activate.bind(admission);
  // Keep real worker opening and session preparation; model publication is unrelated.
  vi.spyOn(admission, "activate").mockImplementation((activation) =>
    activate({ ...activation, publishAgent: async () => {} }),
  );
  activateGatewayAgentDatabaseStartup({
    admission,
    preparationReady: Promise.resolve(),
    waitForPostReadyWork: async () => {},
    getConfig: () => config,
    getPluginRegistry: vi.fn(),
    getPluginMetadataSnapshot: () => undefined,
    isCurrent: () => true,
    log: { info: vi.fn(), warn: vi.fn() },
  });
}

it.for(["missing", "drifted"] as const)(
  "defers every agent's %s index repair until startup activation and repairs it once",
  async (damage, { signal }) => {
    const fixture = await createFixture(["memes", "main", "friends"], damage);
    const { env, config, agents } = fixture;
    for (const agent of agents) {
      expect(readSqliteDatabaseCleanClose(agent.path)).toBe(false);
    }
    const allAdmitted = createDeferredCore();
    const admitted = new Set<string>();
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (!("all" in change) || typeof change.scope !== "object" || !change.scope.topology) {
        return;
      }
      const agentId = change.scope.agentId;
      if (
        agentId &&
        agents.some((agent) => agent.agentId === agentId) &&
        !listAgentDatabaseAdmissionRefusals({ env }).some((refusal) => refusal.agentId === agentId)
      ) {
        admitted.add(agentId);
        if (admitted.size === agents.length) {
          allAdmitted.resolve();
        }
      }
    });
    try {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        await fixture.ready();
        const owner = admission.adopt();
        try {
          for (const agent of agents) {
            const refusal = readAgentDatabaseAdmissionRefusal(agent.agentId, { env });
            expect(refusal?.code).toBe("agent-database-inspection-pending");
            expect(createAgentDatabaseAdmissionErrorShape(refusal!)).toMatchObject({
              code: "UNAVAILABLE",
              retryable: true,
            });
            expect(() => fixture.agent(agent.agentId, agent.path)).toThrow(
              "has not completed startup inspection and preparation",
            );
          }
          await expect(fixture.prepare()).resolves.toEqual([]);
          expect(
            listAgentDatabaseAdmissionRefusals({ env })
              .map(({ agentId }) => agentId)
              .toSorted(),
          ).toEqual(agents.map(({ agentId }) => agentId).toSorted());
          deepStrictEqual(fixture.bytes(), fixture.before);
          activateStartup(admission, config);
          await withinTest(allAdmitted.promise, signal);
        } finally {
          await owner.stop();
        }
      });
    } finally {
      unsubscribe();
    }
    for (const agent of agents) {
      {
        using reader = openRawDatabase(agent.path, { readOnly: true });
        expect(
          reader
            .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_session_nodes_active'")
            .get()?.sql,
        ).toMatch(/WHERE archived_at IS NULL/i);
        expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      }
      expect(loadSessionEntry(agent.session)).toEqual(agent.entry);
    }
    // Worker-local log queues drain on close; the parent logger cannot flush them.
    await closeOpenClawAgentDatabasesAsync();
    await flushLogger();
    const repairs = () =>
      fs
        .readFileSync(fixture.logPath, "utf8")
        .trim()
        .split("\n")
        .map((line): { message?: string; "1"?: unknown } => JSON.parse(line))
        .filter((record) => record.message?.startsWith(repairMessage));
    const ordered = agents.toSorted((a, b) => a.agentId.localeCompare(b.agentId));
    expect(repairs().toSorted((a, b) => (a.message ?? "").localeCompare(b.message ?? ""))).toEqual(
      ordered.map((agent) =>
        expect.objectContaining({
          message: `${repairMessage} for ${agent.agentId} (${agent.path}): idx_agent_session_nodes_active`,
          "1": expect.objectContaining({
            agentId: agent.agentId,
            path: agent.path,
            indexes: ["idx_agent_session_nodes_active"],
            elapsedMs: expect.any(Number),
          }),
        }),
      ),
    );
    await expect(fixture.ready(config, "gateway-restart")).resolves.toBeUndefined();
    await fixture.prepare();
    await closeOpenClawAgentDatabasesAsync();
    await flushLogger();
    expect(repairs()).toHaveLength(3);
  },
);

it.each([
  ["unscoped", "schema", "schema", 78],
  ["unscoped", "unavailable", "schema", 78],
  ["unscoped", "schema", "unavailable", 78],
  ["unscoped", "unavailable", "unavailable", 1],
  ["scoped", "schema", "unavailable", 78],
  ["scoped", "unavailable", "schema", 1],
] as const)("classifies %s %s / %s startup as exit %i", async (scope, first, second, exitCode) => {
  const allSchema = first === "schema" && second === "schema";
  const { env, config, agents, before, bytes, ready } = await createFixture(
    allSchema ? ["work", "memes", "main", "friends"] : ["main", "worker"],
    "missing table",
  );
  const failures = allSchema ? agents.map(() => first) : [first, second];
  const unavailable = agents
    .filter((_, index) => failures[index] === "unavailable")
    .map((agent) => agent.agentId);
  if (unavailable.length > 0) {
    const preload = path.join(env.OPENCLAW_STATE_DIR, "schema-read-failure.cjs");
    fs.writeFileSync(
      preload,
      `const { DatabaseSync } = require('node:sqlite');
     const prepare = DatabaseSync.prototype.prepare;
     DatabaseSync.prototype.prepare = function(sql) {
       if (sql === 'PRAGMA table_list' &&
           prepare.call(this, 'SELECT role FROM schema_meta').get()?.role === 'agent' &&
           ${JSON.stringify(unavailable)}.includes(prepare.call(this, 'SELECT agent_id FROM schema_meta').get()?.agent_id)) {
         throw Object.assign(new Error('synthetic schema read unavailable'), {code: 'SQLITE_IOERR', errcode: 10});
       }
       return prepare.call(this, sql);
     };`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
  }
  const inspect = () =>
    ready(scope === "scoped" ? agentConfig(["main", "worker"], "main") : config);
  const failure = await (
    scope === "scoped"
      ? withAgentDatabaseStartupAdmission(inspect, { deferInspections: false })
      : inspect()
  ).catch((error: unknown) => error);
  const message = String(failure);
  if (scope === "unscoped") {
    const rows = message.split("\n").filter((line) => line.startsWith("agent "));
    expect(rows).toEqual(
      (allSchema ? agents.toSorted((a, b) => a.agentId.localeCompare(b.agentId)) : agents).map(
        (agent) => expect.stringContaining(`agent ${agent.agentId} ${agent.path}:`),
      ),
    );
    for (const [index, kind] of failures.entries()) {
      if (kind === "schema") {
        expect(rows[index]).toContain("missing or drifted index idx_agent_session_nodes_active");
        expect(rows[index]).toContain("openclaw doctor --fix");
      }
      expect(rows[index]).toContain(
        kind === "schema"
          ? "missing table session_key_contract"
          : "synthetic schema read unavailable",
      );
    }
  } else {
    expect(message).toContain(agents[0]?.path);
    expect(message).not.toContain(agents[1]?.path);
    expect(message).toContain(
      first === "schema"
        ? "missing table session_key_contract"
        : "synthetic schema read unavailable",
    );
  }
  expect(resolveGatewayStartupFailureExitCode(failure)).toBe(exitCode);
  deepStrictEqual(bytes(), before);
});

const ftsRowsSql = "SELECT rowid, * FROM session_transcript_fts";
const malformedFts = "malformed inverted index for FTS5 table main.session_transcript_fts";
const repairHint = "openclaw doctor --session-sqlite recover --session-sqlite-agent main";

function expectContents(pathname: string, rows: unknown, integrity: string) {
  using db = openRawDatabase(pathname, { readOnly: true });
  expect(db.prepare(ftsRowsSql).all()).toEqual(rows);
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: integrity }]);
}

function backupPaths(pathname: string) {
  const directory = path.dirname(pathname);
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith("openclaw-index-recovery-"))
    .map((name) => path.join(directory, name, "database.sqlite"));
}

function expectRefusal(env: NodeJS.ProcessEnv) {
  const refused = readAgentDatabaseAdmissionRefusal("main", { env });
  expect(refused?.code).toBe("agent-database-inspection-failed");
  expect(refused?.repairHint).toContain(repairHint);
  return refused;
}

async function createFtsFixture(failure?: "mixed" | "backup" | "rebuild" | "writer") {
  const fixture = await createFixture(["main"], undefined, () => "retained");
  const { env, config, logPath } = fixture;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const { session, entry, path: pathname } = fixture.agents[0]!;
  let rows: unknown;
  {
    using db = openRawDatabase(pathname);
    db.exec("INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd')");
    rows = db.prepare(ftsRowsSql).all();
  }
  installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
  retireSqliteDatabaseAdmissionForPath(pathname);
  if (failure === "mixed") {
    {
      using db = openRawDatabase(pathname);
      db.exec(
        "CREATE TABLE probe(value TEXT); CREATE INDEX idx_probe ON probe(value); INSERT INTO probe VALUES ('abcdefgh')",
      );
    }
    corruptSqliteIndexKey(pathname, "idx_probe", "abcdefgh", "abcdzzzz");
  }
  if (failure === "backup" || failure === "rebuild") {
    const preload = path.join(stateDir, "fail-repair.cjs");
    fs.writeFileSync(
      preload,
      failure === "backup"
        ? `
      const fs = require('node:fs');
      const copy = fs.copyFileSync;
      fs.copyFileSync = function(src, dst, ...args) {
        if (String(dst).includes('openclaw-index-recovery-')) throw new Error('synthetic backup failure');
        return copy.call(this, src, dst, ...args);
      };`
        : `
      const { DatabaseSync } = require('node:sqlite');
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        if (this.location() === ${JSON.stringify(pathname)} && sql.includes("VALUES('rebuild')")) throw new Error('synthetic rebuild failure');
        return exec.call(this, sql);
      };`,
    );
    for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
      vi.stubEnv(key, value);
    }
  }
  const foreignLease =
    failure === "writer"
      ? claimOpenClawAgentDatabaseLease({ agentId: "main", path: pathname, env })
      : undefined;
  const start = () =>
    withAgentDatabaseStartupAdmission(async (admission) => {
      await fixture.ready(config);
      const owner = admission.adopt();
      try {
        activateStartup(admission, config);
        await admission.pendingPreparation;
      } finally {
        await owner.stop();
      }
    });
  return { env, session, entry, pathname, rows, logPath, start, foreignLease };
}

it("admits a tokenizer-mismatched agent at Gateway startup with preserved content and backup", async () => {
  const fixture = await createFtsFixture();
  const { session, entry, pathname, rows, logPath, env } = fixture;
  await fixture.start();
  expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
  expect(readStartupMigrationWarning()).toContain(
    "Rebuilt stale SQLite FTS indexes (agent main): session_transcript_fts=1",
  );
  expect(loadSessionEntry(session)).toEqual(entry);
  expectContents(pathname, rows, "ok");
  const backup = backupPaths(pathname)[0];
  expect(backup).toBeDefined();
  expectContents(backup!, rows, malformedFts);
  await closeOpenClawAgentDatabasesAsync();
  await flushLogger();
  const log = fs.readFileSync(logPath, "utf8");
  expect(
    log.split("\n").filter((line) => line.includes("Rebuilt stale SQLite FTS indexes")),
  ).toHaveLength(1);
  await closeStateDatabaseForTest();
  closeOpenClawAgentDatabasesForTest();
  installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
  retireSqliteDatabaseAdmissionForPath(pathname);
  await fixture.start();
  const refused = expectRefusal(env);
  expect(refused?.reason).toContain("Startup FTS repair failed");
  expectContents(pathname, rows, malformedFts);
  expect(backupPaths(pathname)).toHaveLength(1);
});

it.each(["mixed", "backup", "rebuild", "writer"] as const)(
  "keeps %s failures quarantined with actionable Doctor guidance",
  async (failure) => {
    const fixture = await createFtsFixture(failure);
    try {
      await fixture.start();
      expectRefusal(fixture.env);
      expect(() => loadSessionEntry(fixture.session)).toThrow(/integrity_check|quarantined/);
      using db = openRawDatabase(fixture.pathname, { readOnly: true });
      expect(db.prepare(ftsRowsSql).all()).toEqual(fixture.rows);
      expect(db.prepare("PRAGMA integrity_check").all()).toContainEqual({
        integrity_check: malformedFts,
      });
      const backups = backupPaths(fixture.pathname).filter((pathname) => fs.existsSync(pathname));
      expect(backups).toHaveLength(failure === "rebuild" ? 1 : 0);
    } finally {
      if (fixture.foreignLease) {
        releaseOpenClawAgentDatabaseLease(fixture.foreignLease, { env: fixture.env });
      }
    }
  },
);
