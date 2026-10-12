import { deepStrictEqual } from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayStartupFailureExitCode } from "../cli/gateway-cli/startup-maintenance.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { activateGatewayAgentDatabaseStartup } from "../gateway/server-agent-database-startup.js";
import { prepareGatewayStartupSessions } from "../gateway/server-startup-session-migration.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readSqliteDatabaseCleanClose,
  retireSqliteDatabaseAdmissionForPath,
} from "../infra/sqlite-database-admission.js";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";
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
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repairMessage = "Rebuilt canonical agent SQLite indexes";

afterEach(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  await flushLogger();
  setLoggerOverride(null);
  resetLogger();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createFixture(ids: string[], damage: "missing" | "drifted" | "missing table") {
  const stateDir = fs.realpathSync.native(tempDirs.make("startup-index-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
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
  setLoggerOverride({ level: "warn", file: logPath, consoleLevel: "silent" });
  const agents = [];
  for (const agentId of ids) {
    const session = { agentId, env, sessionKey: `agent:${agentId}:retained` };
    const entry = await replaceSessionEntry(session, {
      sessionId: `${agentId}-history`,
      updatedAt: 1,
    });
    expect(entry).not.toBeNull();
    agents.push({ agentId, path: resolveOpenClawAgentSqlitePath(session), session, entry });
  }
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  const { DatabaseSync } = requireNodeSqlite();
  for (const agent of agents) {
    const writer = new DatabaseSync(agent.path);
    writer.exec("DROP INDEX idx_agent_session_nodes_active;");
    writer.exec("UPDATE schema_meta SET app_version = '2026.9.1';");
    if (damage === "drifted") {
      writer.exec("CREATE INDEX idx_agent_session_nodes_active ON session_nodes(session_key);");
    } else if (damage === "missing table") {
      writer.exec("DROP TABLE session_key_contract;");
    }
    writer.close();
    retireSqliteDatabaseAdmissionForPath(agent.path);
  }
  return {
    env,
    config,
    agents,
    logPath,
    before: agents.map((agent) => fs.readFileSync(agent.path)),
  };
}

it.for(["missing", "drifted"] as const)(
  "defers every agent's %s index repair until startup activation and repairs it once",
  async (damage, { signal }) => {
    const { env, config, agents, logPath, before } = await createFixture(
      ["memes", "main", "friends"],
      damage,
    );
    const prepareStartup = () =>
      prepareGatewayStartupSessions({
        cfg: config,
        env,
        log: { info: vi.fn(), warn: vi.fn() },
      });
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
        await assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config });
        const owner = admission.adopt();
        try {
          for (const agent of agents) {
            const refusal = readAgentDatabaseAdmissionRefusal(agent.agentId, { env });
            expect(refusal?.code).toBe("agent-database-inspection-pending");
            expect(createAgentDatabaseAdmissionErrorShape(refusal!)).toMatchObject({
              code: "UNAVAILABLE",
              retryable: true,
            });
            expect(() => openOpenClawAgentDatabase({ ...agent, env })).toThrow(
              "has not completed startup inspection and preparation",
            );
          }
          await expect(prepareStartup()).resolves.toEqual([]);
          expect(
            listAgentDatabaseAdmissionRefusals({ env })
              .map(({ agentId }) => agentId)
              .toSorted(),
          ).toEqual(agents.map(({ agentId }) => agentId).toSorted());
          deepStrictEqual(
            agents.map((agent) => fs.readFileSync(agent.path)),
            before,
          );
          const activate = admission.activate.bind(admission);
          // Keep real worker opening and session preparation; model publication is unrelated.
          vi.spyOn(admission, "activate").mockImplementation((activation) =>
            activate({ ...activation, publishAgent: async () => {} }),
          );
          activateGatewayAgentDatabaseStartup({
            admission,
            preparationReady: Promise.resolve(),
            getConfig: () => config,
            getPluginRegistry: vi.fn(),
            getPluginMetadataSnapshot: () => undefined,
            isCurrent: () => true,
            log: { info: vi.fn(), warn: vi.fn() },
          });
          await withinTest(allAdmitted.promise, signal);
        } finally {
          await owner.stop();
        }
      });
    } finally {
      unsubscribe();
    }
    for (const agent of agents) {
      const reader = new (requireNodeSqlite().DatabaseSync)(agent.path, { readOnly: true });
      try {
        expect(
          reader
            .prepare("SELECT sql FROM sqlite_schema WHERE name='idx_agent_session_nodes_active'")
            .get()?.sql,
        ).toMatch(/WHERE archived_at IS NULL/i);
        expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        reader.close();
      }
      expect(loadSessionEntry(agent.session)).toEqual(agent.entry);
    }
    // Worker-local log queues drain on close; the parent logger cannot flush them.
    await closeOpenClawAgentDatabasesAsync();
    await flushLogger();
    const repairs = () =>
      fs
        .readFileSync(logPath, "utf8")
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
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart", config }),
    ).resolves.toBeUndefined();
    await prepareStartup();
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
  const { env, config, agents, before } = await createFixture(
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
    assertOpenClawDatabasesReady({
      env,
      operation: "gateway-startup",
      config:
        scope === "scoped"
          ? {
              agents: {
                entries: { main: {}, worker: {} },
                defaults: { systemAgent: { agentId: "main" } },
              },
            }
          : config,
    });
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
  deepStrictEqual(
    agents.map((agent) => fs.readFileSync(agent.path)),
    before,
  );
});
