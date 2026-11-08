import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { collectAdmissionProtectedSessionIds } from "./session-history-eviction.js";

const json = (sessionId: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ sessionId, updatedAt: 1, ...fields });
const dashboardKey = (suffix: string) => `agent:main:dashboard:${suffix}`;
async function protect(db: DatabaseSync, storePath: string, identities: string[]) {
  const admission = await beginSessionEffect({ scope: storePath, identities, assertAllowed() {} });
  return {
    release: () => admission.release(),
    [Symbol.dispose]: () => admission.release(),
    collect: () => collectAdmissionProtectedSessionIds({ database: { db }, storePath }),
  };
}

it("reads only admitted entry payloads while protecting normalized keys and every generation", async () => {
  using db = new DatabaseSync(":memory:");
  let payloadReads = 0;
  db.function("read_payload", (value) => {
    payloadReads++;
    return value;
  });
  db.exec(`
    CREATE TABLE stored_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT);
    CREATE VIEW session_nodes AS SELECT session_key, current_session_id, read_payload(entry_json) AS entry_json FROM stored_nodes;
    CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT);
  `);
  const insert = db.prepare("INSERT INTO stored_nodes VALUES (?, ?, ?)");
  const addWindow = db.prepare("INSERT INTO session_windows VALUES (?, ?)");
  const entries: Array<[string, string, boolean?]> = [
    [dashboardKey("tracked"), "AGENT:MAIN:DASHBOARD:TRACKED"],
    [dashboardKey("İtem"), dashboardKey("i\u0307tem")],
    [dashboardKey("zero\0tail"), dashboardKey("zero\0tail")],
    ["agent:main:signal:group:AbC=", "agent:main:signal:group:AbC="],
    [dashboardKey("invalid"), dashboardKey("invalid"), true],
  ];
  const identities = [...entries.map(([, identity]) => identity), "by-id", "orphan-owner"];
  const expected = new Set(identities);
  for (const [index, [key, , invalid]] of entries.entries()) {
    const sessionId = `current-${index}`;
    const previousSessionId = `previous-${index}`;
    insert.run(key, sessionId, invalid ? "{" : json(sessionId, { previousSessionId }));
    addWindow.run(`historical-${index}`, key);
    expected.add(sessionId).add(`historical-${index}`);
    if (!invalid) {
      expected.add(previousSessionId);
    }
  }
  addWindow.run("orphan-generation", "orphan-owner");
  expected.add("orphan-generation");
  // The lowercase Signal peer is a different conversation, not an alias.
  insert.run("agent:main:signal:group:abc=", "different-peer", json("different-peer"));
  insert.run(
    dashboardKey("unrelated"),
    "unrelated",
    json("unrelated", { skillsSnapshot: { prompt: "x".repeat(32_768), skills: [] } }),
  );
  using admission = await protect(db, "synthetic-admission-protection", identities);
  expect(admission.collect()).toEqual(expected);
  expect(payloadReads).toBe(entries.length);
  admission.release();
  payloadReads = 0;
  expect(admission.collect()).toEqual(new Set());
  expect(payloadReads).toBe(0);
});

it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
  "preserves admission protection through raw %s key decoding",
  async (encoding) => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA encoding='${encoding}';
      CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT, entry_json TEXT);
      CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT);
    `);
    const insert = db.prepare("INSERT INTO session_nodes VALUES (CAST(? AS TEXT), ?, ?)");
    const addWindow = db.prepare("INSERT INTO session_windows VALUES (?, CAST(? AS TEXT))");
    const expected = new Set<string>();
    for (const [index, suffix] of ["\uFFFE", "\uFFFF", "\uD800", "\uDC00", "\0tail"].entries()) {
      const key = `agent:main:dashboard:raw-${index}-${suffix}`;
      // Bind a BLOB so SQLite retains the original encoding before Node decodes the key.
      const bytes = Buffer.from(key, encoding === "UTF-8" ? "utf8" : "utf16le");
      if (encoding === "UTF-16be") {
        bytes.swap16();
      }
      const sessionId = `current-${index}`;
      const previousSessionId = `previous-${index}`;
      insert.run(bytes, sessionId, json(sessionId, { previousSessionId }));
      addWindow.run(`historical-${index}`, bytes);
      expected.add(sessionId).add(previousSessionId).add(`historical-${index}`);
    }
    const identities = db
      .prepare("SELECT session_key FROM session_nodes")
      .all()
      .map((row) => String(row.session_key));
    identities.forEach((identity) => expected.add(identity));
    using admission = await protect(db, `synthetic-raw-admission-${encoding}`, identities);
    expect(admission.collect()).toEqual(expected);
  },
);
