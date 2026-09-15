import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";

let database: DatabaseSync;
const cutoff = 1_000;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  for (const table of ["session_nodes", "conversations", "session_windows"]) {
    const ddl = OPENCLAW_AGENT_SCHEMA_SQL.match(
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\) STRICT;`),
    )?.[0];
    if (!ddl) {
      throw new Error(`Missing canonical fixture table ${table}`);
    }
    database.exec(ddl);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

function addNode(id: string, metadata: Record<string, unknown> = {}, raw?: string) {
  const key = `agent:main:${id}`;
  const entryJson = raw ?? JSON.stringify({ sessionId: id, updatedAt: 1, ...metadata });
  database
    .prepare(
      "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at) VALUES (?,?,?,1)",
    )
    .run(key, id, entryJson);
  addWindow(key, id);
  return { key, entryJson };
}

function addWindow(key: string, id: string, updatedAt = 1, transcriptAt: number | null = 1) {
  database
    .prepare(
      "INSERT INTO session_windows (session_id,session_key,created_at,updated_at,transcript_updated_at) VALUES (?,?,1,?,?)",
    )
    .run(id, key, updatedAt, transcriptAt);
}

function protect(beforeMs = cutoff) {
  return readSessionColdStorageProtection({ db: database }, beforeMs);
}

describe("cold-storage protection selection", () => {
  it("decodes each node only once while leaving old idle generations unprotected", () => {
    const { key, entryJson } = addNode("idle", { archivedAt: 2, pinnedAt: 3 });
    for (let i = 0; i < 1_000; i++) {
      addWindow(key, `history-${i}`);
    }
    addWindow(key, "recent-history", cutoff);
    let hydratedWindows = 0;
    const prepare = database.prepare.bind(database);
    vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes('from "session_windows"')) {
        const all = statement.all.bind(statement);
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "all").mockImplementation((...args) => {
          const rows = all(...args);
          hydratedWindows += rows.length;
          return rows;
        });
        vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
          for (const row of iterate(...args)) {
            hydratedWindows++;
            yield row;
          }
          return undefined;
        });
      }
      return statement;
    });
    const parsed = vi.spyOn(JSON, "parse");
    expect(protect()).toEqual(new Set(["recent-history"]));
    expect(hydratedWindows).toBe(1);
    expect(parsed.mock.calls.filter(([text]) => text === entryJson)).toHaveLength(1);
  });

  it("preserves each running and recent node/window protection source at the cutoff", () => {
    for (const column of ["updated_at", "last_activity_at", "last_interaction_at"]) {
      addNode(column);
      database
        .prepare(`UPDATE session_nodes SET ${column} = ? WHERE current_session_id = ?`)
        .run(cutoff, column);
      if (column === "updated_at") {
        database
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE current_session_id = ?")
          .run(JSON.stringify({ sessionId: column, updatedAt: cutoff }), column);
      }
    }
    addNode("running-node");
    database
      .prepare("UPDATE session_nodes SET status = 'running' WHERE current_session_id = ?")
      .run("running-node");
    const { key } = addNode("old-node");
    addWindow(key, "recent-window", cutoff, null);
    addWindow(key, "recent-transcript", 1, cutoff);
    addWindow(key, "running-window");
    addWindow(key, "old-null-transcript", 1, null);
    database
      .prepare("UPDATE session_windows SET status = 'running' WHERE session_id = ?")
      .run("running-window");
    expect(protect()).toEqual(
      new Set([
        "updated_at",
        "last_activity_at",
        "last_interaction_at",
        "running-node",
        "recent-window",
        "recent-transcript",
        "running-window",
      ]),
    );
  });

  it("retains explicit cross-generation references without treating archive or pin as activity", () => {
    addNode("idle", {
      archivedAt: 2,
      pinnedAt: 3,
      previousSessionId: "previous",
      usageFamilySessionIds: ["idle", "usage"],
      compactionCheckpoints: [
        {
          sessionId: "checkpoint",
          preCompaction: { sessionId: "before" },
          postCompaction: { sessionId: "after" },
        },
      ],
    });
    expect(protect()).toEqual(new Set(["previous", "usage", "checkpoint", "before", "after"]));
  });

  it.each([
    { restartRecoveryBeforeAgentReplyState: "admitted" },
    { restartRecoveryBeforeAgentReplyState: "pending" },
    { restartRecoveryBeforeAgentReplyState: "continue" },
    { restartRecoveryDeliveryReceiptState: "terminal-pending" },
    { mainRestartRecovery: { reservation: { id: "claim" } } },
    { mainRestartRecovery: { foregroundClaims: [] } },
  ])("protects every generation of recovery-owned nodes (%j)", (metadata) => {
    const { key } = addNode("recovery", metadata);
    addWindow(key, "old-recovery-window");
    addNode("unrelated-idle");
    expect(protect()).toEqual(new Set(["recovery", "old-recovery-window"]));
  });

  it.each([
    "not-json",
    "{}",
    '{"sessionId":"other","updatedAt":1}',
    '{"sessionId":"corrupt","updatedAt":2}',
  ])("fails closed for unreadable or mismatched node metadata (%s)", (raw) => {
    const { key } = addNode("corrupt", {}, raw);
    addWindow(key, "old-corrupt-window");
    addNode("unrelated-idle");
    expect(protect()).toEqual(new Set(["corrupt", "old-corrupt-window"]));
  });

  it("preserves the zero fallback for a null transcript timestamp", () => {
    const { key } = addNode("negative-time");
    database
      .prepare("UPDATE session_nodes SET updated_at = -1, entry_json = ?")
      .run(JSON.stringify({ sessionId: "negative-time", updatedAt: -1 }));
    database
      .prepare("UPDATE session_windows SET updated_at = -1, transcript_updated_at = NULL")
      .run();
    addWindow(key, "old-nonnull", -1, -1);
    addWindow(key, "null-history", -1, null);
    expect(protect(0)).toEqual(new Set(["negative-time", "null-history"]));
  });

  it.each([false, true])(
    "preserves pending-input protection with consumption column=%s",
    (consumption) => {
      database.exec(`CREATE TABLE session_pending_inputs (
      session_id TEXT, state TEXT${consumption ? ", consumed_event_id TEXT" : ""}
    )`);
      database.exec(
        "INSERT INTO session_pending_inputs (session_id,state) VALUES ('queued','queued'),('interrupted','interrupted'),('done','done')",
      );
      if (consumption) {
        database.exec("INSERT INTO session_pending_inputs VALUES ('consumed','queued','event')");
      }
      expect(protect()).toEqual(new Set(["queued", "interrupted"]));
    },
  );
});
