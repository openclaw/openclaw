import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import { readSqliteCleanCloseSeal } from "../infra/sqlite-clean-close-seal.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createStartupTestState, gatewayStartupOptions } from "./server-startup.test-support.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

// Records each whole-database integrity statement (integrity_check or quick_check without a
// table argument) run on the counted path, in this process and in every forked child. A
// startup that rescans a healthy agent database costs time proportional to its size.
const counterSource = `
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
const whole = /PRAGMA\\s+(?:\\w+\\.)?(?:integrity_check|quick_check)\\s*(?:\\(\\s*\\d*\\s*\\))?\\s*;?\\s*$/i;
const record = (db, sql) => {
  const out = process.env.OPENCLAW_TEST_INTEGRITY_COUNT_FILE;
  if (!out || !whole.test(String(sql).trim())) return;
  if (db.location() === process.env.OPENCLAW_TEST_INTEGRITY_COUNT_PATH) {
    fs.appendFileSync(out, "check\\n");
  }
};
for (const method of ["prepare", "exec"]) {
  const original = DatabaseSync.prototype[method];
  if (original.integrityCounted) continue;
  const counted = function (sql, ...rest) {
    record(this, sql);
    return original.call(this, sql, ...rest);
  };
  counted.integrityCounted = true;
  DatabaseSync.prototype[method] = counted;
}
`;
const counterImport = `data:text/javascript,${encodeURIComponent(counterSource)}`;
const previousNodeOptions = process.env.NODE_OPTIONS;
const originalPrepare = DatabaseSync.prototype.prepare;
const originalExec = DatabaseSync.prototype.exec;

beforeAll(async () => {
  // Children forked after this point load the counter; this process loads it once.
  process.env.NODE_OPTIONS = `${previousNodeOptions ?? ""} --import ${counterImport}`.trim();
  await import(counterImport);
});
afterEach(() => {
  delete process.env.OPENCLAW_TEST_INTEGRITY_COUNT_FILE;
  delete process.env.OPENCLAW_TEST_INTEGRITY_COUNT_PATH;
});
afterAll(() => {
  DatabaseSync.prototype.prepare = originalPrepare;
  DatabaseSync.prototype.exec = originalExec;
  if (previousNodeOptions === undefined) {
    delete process.env.NODE_OPTIONS;
  } else {
    process.env.NODE_OPTIONS = previousNodeOptions;
  }
});

it.each([
  { seal: "valid", wholeChecksBeforeListen: 0 },
  { seal: "missing", wholeChecksBeforeListen: 1 },
])(
  "starts beside an unrelated legacy import with $seal agent seal after $wholeChecksBeforeListen whole-database checks",
  async ({ seal, wholeChecksBeforeListen }) => {
    await using state = await createStartupTestState("gateway-startup-agent-integrity");
    const token = "synthetic-agent-integrity-gateway-token";
    const claim = await acquireGatewayE2ePortBlock();
    await state.writeConfig({
      gateway: {
        mode: "local",
        auth: { mode: "token", token },
        port: claim.port,
        controlUi: { enabled: false },
      },
      plugins: { enabled: false },
      discovery: { mdns: { mode: "off" } },
    });
    state.applyEnv();
    const env = state.env;
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env });
    const countFile = path.join(state.stateDir, "integrity-statements.log");
    // Set before any store opens, so every child the startup forks inherits the counter.
    process.env.OPENCLAW_TEST_INTEGRITY_COUNT_FILE = countFile;
    process.env.OPENCLAW_TEST_INTEGRITY_COUNT_PATH = databasePath;

    // A healthy store as explicit Doctor leaves it, closed after a full check with its seal.
    const sealAfterFullCheck = async () => {
      const maintenance = createOpenClawDatabaseMaintenanceScope({ sqliteIntegrityCheck: "full" });
      try {
        maintenance.run(() => openOpenClawAgentDatabase({ agentId: "main", env }));
        closeOpenClawAgentDatabasesForTest();
      } finally {
        await maintenance.close();
      }
      closeOpenClawStateDatabaseForTest();
      retireSqliteDatabaseAdmissionForPath(databasePath);
    };
    await sealAfterFullCheck();
    // Doctor's writing pass leaves the media receipt and planner statistics a settled store has.
    expect(
      await migrateLegacyMediaPersistence({
        env,
        configuredAgentDatabaseTargets: [{ agentId: "main", path: databasePath }],
      }),
    ).toMatchObject({ warnings: [] });
    closeOpenClawAgentDatabasesForTest();
    await sealAfterFullCheck();
    expect(
      readSqliteCleanCloseSeal(databasePath, fs.statSync(databasePath, { bigint: true })),
    ).toBeDefined();
    if (seal === "missing") {
      fs.unlinkSync(`${databasePath}.seal`);
    }
    // An unrelated legacy import sends boot through Doctor's migration graph.
    const legacy = path.join(state.stateDir, "tui", "last-session.json");
    fs.mkdirSync(path.dirname(legacy));
    fs.writeFileSync(
      legacy,
      JSON.stringify({ terminal: { sessionKey: "agent:main:tui-123", updatedAt: 100 } }),
    );
    // Only the measured start counts; the fixture's own sealing checks came before.
    fs.rmSync(countFile, { force: true });

    const server = await startClaimedGateway(claim, async () => {
      const preflight = await runStartupConfigPreflight({ gateway: true, observe: false });
      try {
        const { startGatewayServer } = await import("./server.js");
        return await startGatewayServer(claim.port, {
          ...gatewayStartupOptions(token),
          startupConfigSnapshotRead: preflight,
        });
      } finally {
        await preflight.pluginCache?.[Symbol.asyncDispose]();
      }
    });
    try {
      const beforeListen = fs.existsSync(countFile)
        ? fs.readFileSync(countFile, "utf8").split("\n").filter(Boolean).length
        : 0;
      expect(fs.existsSync(legacy)).toBe(false);
      expect(beforeListen).toBe(wholeChecksBeforeListen);
      expect((await fetch(`http://127.0.0.1:${claim.port}/readyz`)).status).toBe(200);
    } finally {
      await server.close();
    }
  },
);
