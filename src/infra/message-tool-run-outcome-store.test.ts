import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { recordMessageToolRunOutcome } from "./message-tool-run-outcome-store.js";

const outcomeFault = useSqliteWorkerFault([
  {
    name: "refuse_outcome",
    match: /^insert into message_tool_run_outcomes /,
    sql: `CREATE TEMP TRIGGER refuse_outcome BEFORE INSERT ON main.message_tool_run_outcomes
      WHEN NEW.run_id = 'refused' BEGIN SELECT RAISE(ABORT, 'outcome refused'); END;`,
  },
]);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let env: NodeJS.ProcessEnv;
let target: { agentId: string; env: NodeJS.ProcessEnv };
beforeEach(() => {
  env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-message-tool-outcome-") };
  target = { agentId: "main", env };
});

const openDatabase = (file?: string) => openOpenClawAgentDatabase({ ...target, path: file });
const readRows = (db: ReturnType<typeof openDatabase>["db"], columns = "run_id") =>
  db.prepare(`SELECT ${columns} FROM message_tool_run_outcomes ORDER BY id`).all();
type Outcome = Parameters<typeof recordMessageToolRunOutcome>[0];

const outcomeInput = (runId: string, overrides: Partial<Outcome> = {}) => ({
  ...target,
  sessionKey: "agent:main:main",
  provider: "openai",
  model: "gpt-5.6-luna",
  outcome: "mute" as const,
  runStatus: "completed" as const,
  occurredAt: 100,
  ...overrides,
  runId,
});

const recordOutcome = (runId: string, overrides?: Parameters<typeof outcomeInput>[1]) =>
  recordMessageToolRunOutcome(outcomeInput(runId, overrides));

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

describe("message-tool run outcome store", () => {
  it.each([false, true])(
    "records durable outcomes without caller-thread SQL (custom=%s)",
    async (custom) => {
      const storePath = custom ? path.join(env.OPENCLAW_STATE_DIR!, "custom.sqlite") : undefined;
      const database = openDatabase(storePath);
      const rejectCallerSql = () => expect.fail("SQL ran on the caller");
      const prepare = vi
        .spyOn(DatabaseSync.prototype, "prepare")
        .mockImplementation(rejectCallerSql);
      const exec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(rejectCallerSql);
      try {
        await recordOutcome("worker-boundary", { outcome: "tool_delivered", storePath });
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
      expect(readRows(database.db)).toEqual([{ run_id: "worker-boundary" }]);
    },
  );

  it("lazily records typed completion facts in an existing same-version database", async () => {
    const database = openDatabase();
    database.db.exec("DROP TABLE message_tool_run_outcomes;");
    closeOpenClawAgentDatabasesForTest();

    for (const [runId, outcome, runStatus] of [
      ["run-delivered", "tool_delivered", "completed"],
      ["run-mute", "mute", "completed"],
      ["run-error", "mute", "errored"],
    ] as const) {
      await recordOutcome(runId, { outcome, runStatus });
    }

    outcomeFault.enable();
    try {
      await expect(recordOutcome("refused", { runStatus: "errored" })).rejects.toMatchObject({
        code: "ERR_SQLITE_ERROR",
        errcode: 1811,
      });
    } finally {
      outcomeFault.disable();
    }

    expect(readRows(openDatabase().db, "run_id, outcome, run_status")).toEqual([
      { run_id: "run-delivered", outcome: "tool_delivered", run_status: "completed" },
      { run_id: "run-mute", outcome: "mute", run_status: "completed" },
      { run_id: "run-error", outcome: "mute", run_status: "errored" },
    ]);
  });

  it("prunes the per-agent operational history to 10,000 newest rows", async () => {
    const database = openDatabase();
    database.db.exec(`
      WITH RECURSIVE rows(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM rows WHERE value <= 10000
      )
      INSERT INTO message_tool_run_outcomes (
        run_id, session_key, agent_id, provider, model, outcome, run_status, occurred_at
      )
      SELECT
        'seed-' || value, 'agent:main:main', 'main', 'openai', 'gpt-5.6-luna',
        'mute', 'completed', value / 2
      FROM rows;
    `);

    await recordOutcome("newest", { outcome: "tool_delivered", occurredAt: 20_000 });

    const retained = database.db
      .prepare(`
      SELECT COUNT(*) AS count, MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest,
        (SELECT run_id FROM message_tool_run_outcomes ORDER BY occurred_at, id LIMIT 1) AS first
      FROM message_tool_run_outcomes
    `)
      .get();
    expect(retained).toEqual({ count: 10_000, oldest: 1, newest: 20_000, first: "seed-3" });
  });

  it("preserves FIFO against other agent writes and captures queued inputs", async () => {
    const db = openDatabase().db;
    const gate = createDeferredCore();
    const ahead = runOpenClawAgentWriteAdmission(target, () => gate.promise);
    const input = outcomeInput("first");
    const first = recordMessageToolRunOutcome(input);
    const between = runOpenClawAgentWriteAdmission(target, () => readRows(db));
    const second = recordOutcome("second", input);
    input.runId = "mutated";
    input.sessionKey = "agent:main:changed";
    env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-message-tool-unselected-");
    gate.resolve();
    await Promise.all([ahead, first, second]);
    expect(await between).toEqual([{ run_id: "first" }]);
    expect(readRows(db, "run_id, session_key")).toEqual([
      { run_id: "first", session_key: "agent:main:main" },
      { run_id: "second", session_key: "agent:main:main" },
    ]);
  });

  it("refuses queued recording after close instead of opening a successor", async () => {
    openDatabase();
    const gate = createDeferredCore();
    const ahead = runOpenClawAgentWriteAdmission(target, () => gate.promise);
    const pending = recordOutcome("closed", { runStatus: "aborted" });
    const refused = expect(pending).rejects.toThrow(/revoked|closed/);
    try {
      await closeOpenClawAgentDatabasesAsync();
    } finally {
      gate.resolve();
    }
    await ahead;
    await refused;
    expect(getOpenClawAgentDatabaseIfOpen(target)).toBeUndefined();
  });

  it("does not recreate an absent incognito session for late outcome metadata", async () => {
    await expect(
      recordOutcome("private", {
        sessionKey: "agent:main:dashboard:incognito-outcome",
        runStatus: "aborted",
      }),
    ).rejects.toThrow("incognito");
    const privateTarget = { ...target, path: resolveIncognitoOpenClawAgentSqlitePath(target) };
    expect(memorySessionActorOwners.read(privateTarget)).toBeUndefined();
    expect(getOpenClawAgentDatabaseIfOpen(privateTarget)).toBeUndefined();
    expect(getOpenClawAgentDatabaseIfOpen(target)).toBeUndefined();
  });
});
