import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../../state/openclaw-agent-schema.js";
import * as entryStatus from "./session-accessor.sqlite-status.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import { readSessionAdmissionProtectionKeys } from "./session-cold-storage-selection.js";
import * as entryCodec from "./session-entry-json.js";
import { deriveSessionPredicateColumns } from "./session-predicate-columns.js";

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

afterEach(() => database.close());

function addNode(id: string, metadata: Record<string, unknown> = {}, raw?: string) {
  const key = `agent:main:${id}`;
  const entryJson = raw ?? JSON.stringify({ sessionId: id, updatedAt: 1, ...metadata });
  const predicates = deriveSessionPredicateColumns(entryJson);
  database
    .prepare(
      "INSERT INTO session_nodes (session_key,current_session_id,entry_json,updated_at,session_started_at,has_optional_references) VALUES (?,?,?,1,?,?)",
    )
    .run(key, id, entryJson, predicates.session_started_at, predicates.has_optional_references);
  addWindow(key, id);
  return { key };
}

function addWindow(key: string, id: string, updatedAt = 1, transcriptAt: number | null = 1) {
  database
    .prepare(
      "INSERT INTO session_windows (session_id,session_key,created_at,updated_at,transcript_updated_at) VALUES (?,?,1,?,?)",
    )
    .run(id, key, updatedAt, transcriptAt);
}

function protect(beforeMs = cutoff, liveSessionKeys: ReadonlySet<string> = new Set()) {
  return readSessionColdStorageProtection({ db: database }, beforeMs, liveSessionKeys);
}

function expectProtection(ids: string[], beforeMs = cutoff, liveKeys: string[] = []) {
  expect(protect(beforeMs, new Set(liveKeys))).toEqual(new Set(ids));
}

function checkpoint(sessionId: string, before = sessionId, after = sessionId) {
  return { sessionId, preCompaction: { sessionId: before }, postCompaction: { sessionId: after } };
}

it("selects live, recovering, and recent windows without preserving idle history", () => {
  const idle = addNode("idle", { archivedAt: 2, pinnedAt: 3 });
  for (let i = 0; i < 1_000; i++) {
    addWindow(idle.key, `history-${i}`, cutoff - 1, i % 2 === 0 ? null : cutoff - 1);
  }
  addWindow(idle.key, "recent-history", cutoff, null);
  addWindow(idle.key, "recent-transcript", cutoff - 1, cutoff);
  const live = addNode("live-history");
  addWindow(live.key, "running-history", cutoff - 1, null);
  const protectedNode = addNode("busy", { restartRecoveryBeforeAgentReplyState: "pending" });
  addWindow(protectedNode.key, "old-busy-history", cutoff - 1, null);
  for (const column of ["updated_at", "last_activity_at", "last_interaction_at"]) {
    addNode(column, { updatedAt: column === "updated_at" ? cutoff : 1 });
    database
      .prepare(`UPDATE session_nodes SET ${column} = ? WHERE current_session_id = ?`)
      .run(cutoff, column);
  }
  const expected = new Set([
    "recent-history",
    "recent-transcript",
    "live-history",
    "running-history",
    "busy",
    "old-busy-history",
    "updated_at",
    "last_activity_at",
    "last_interaction_at",
  ]);
  expect(protect(cutoff, new Set([live.key]))).toEqual(expected);
});

it("retains explicit cross-generation references without treating archive or pin as activity", () => {
  addNode("idle", {
    archivedAt: 2,
    pinnedAt: 3,
    previousSessionId: "previous",
    usageFamilySessionIds: ["idle", "usage"],
    compactionCheckpoints: [checkpoint("checkpoint", "before", "after")],
  });
  expectProtection(["previous", "usage", "checkpoint", "before", "after"]);
});

it("does not let legacy checkpoint self-references protect an idle current window", () => {
  addNode("idle", {
    compactionCheckpoints: [checkpoint("idle"), checkpoint("idle", "older-generation")],
  });
  expectProtection(["older-generation"]);
  database
    .prepare("UPDATE session_nodes SET last_activity_at = ? WHERE current_session_id = ?")
    .run(cutoff, "idle");
  expectProtection(["idle", "older-generation"]);
});

it.each([
  { restartRecoveryBeforeAgentReplyState: "admitted" },
  { restartRecoveryBeforeAgentReplyState: "continue" },
  { restartRecoveryDeliveryReceiptState: "terminal-pending" },
  { mainRestartRecovery: { reservation: { id: "claim" } } },
  { mainRestartRecovery: { foregroundClaims: [] } },
])("protects every generation of recovery-owned nodes (%j)", (metadata) => {
  const { key } = addNode("recovery", metadata);
  addWindow(key, "old-recovery-window");
  addNode("unrelated-idle");
  expectProtection(["recovery", "old-recovery-window"]);
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
  expectProtection(["corrupt", "old-corrupt-window"]);
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
  expectProtection(["negative-time", "null-history"], 0);
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
    expectProtection(["queued", "interrupted"]);
  },
);

it("checks selected windows against their owners and all cross-generation references", () => {
  const busy = addNode("recovering", { restartRecoveryBeforeAgentReplyState: "pending" });
  addWindow(busy.key, "busy-history");
  const invalid = addNode("invalid", {}, "not-json");
  addWindow(invalid.key, "invalid-history");
  addNode("reference-owner", { previousSessionId: "referenced-history" });
  const idle = addNode("idle");
  addWindow(idle.key, "referenced-history");
  addWindow(idle.key, "idle-history");
  addWindow(idle.key, "recent-history", cutoff);
  const selected = [
    "busy-history",
    "invalid-history",
    "referenced-history",
    "idle-history",
    "recent-history",
  ];
  for (let i = 0; i < 100; i++) {
    addNode(`unrelated-${i}`);
  }
  const full = protect();
  const parse = vi.spyOn(entryCodec, "parseCanonicalSqliteSessionEntry");
  try {
    const narrowed = readSessionColdStorageProtection(
      { db: database },
      cutoff,
      new Set(),
      selected,
    );
    expect(selected.filter((id) => narrowed.has(id))).toEqual(
      selected.filter((id) => full.has(id)),
    );
    expect(selected.filter((id) => narrowed.has(id))).toEqual([
      "busy-history",
      "invalid-history",
      "referenced-history",
      "recent-history",
    ]);
    expect(parse).toHaveBeenCalledTimes(4);
  } finally {
    parse.mockRestore();
  }
});

it("uses admitted reference facts while retaining invalid and trimmed current IDs", () => {
  addNode("current");
  addNode(" padded ");
  for (let i = 0; i < 100; i++) {
    addNode(`unrelated-${i}`);
  }
  database.exec("UPDATE session_nodes SET entry_valid = 1");
  addNode("reference-owner", { previousSessionId: "historical" });
  addNode("invalid", {}, "not-json");
  const parse = vi.spyOn(entryStatus, "parseSessionEntryJson");
  try {
    expect(
      readSessionAdmissionProtectionKeys({ db: database }, [
        "current",
        "padded",
        "historical",
        "invalid",
      ]),
    ).toEqual(
      new Set([
        "agent:main:current",
        "agent:main: padded",
        "agent:main:reference-owner",
        "agent:main:invalid",
      ]),
    );
    expect(parse).toHaveBeenCalledTimes(2);
  } finally {
    parse.mockRestore();
  }
});
