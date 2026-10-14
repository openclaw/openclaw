import { DatabaseSync } from "node:sqlite";
import { expect, it, onTestFinished } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { collectAdmissionProtectedSessionIds } from "./session-history-eviction.js";

it("reads only admitted entry payloads while protecting normalized keys and every generation", async () => {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
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
  const entries = [
    { key: "agent:main:dashboard:tracked", identity: "AGENT:MAIN:DASHBOARD:TRACKED" },
    { key: "agent:main:dashboard:İtem", identity: "agent:main:dashboard:i\u0307tem" },
    { key: "agent:main:dashboard:zero\0tail", identity: "agent:main:dashboard:zero\0tail" },
    { key: "agent:main:signal:group:AbC=", identity: "agent:main:signal:group:AbC=" },
    {
      key: "agent:main:dashboard:invalid",
      identity: "agent:main:dashboard:invalid",
      invalid: true,
    },
  ];
  const identities = [...entries.map((entry) => entry.identity), "by-id", "orphan-owner"];
  const expected = new Set(identities);
  for (const [index, entry] of entries.entries()) {
    const sessionId = `current-${index}`;
    const previousSessionId = `previous-${index}`;
    insert.run(
      entry.key,
      sessionId,
      entry.invalid ? "{" : JSON.stringify({ sessionId, previousSessionId, updatedAt: 1 }),
    );
    addWindow.run(`historical-${index}`, entry.key);
    expected.add(sessionId);
    expected.add(`historical-${index}`);
    if (!entry.invalid) {
      expected.add(previousSessionId);
    }
  }
  addWindow.run("orphan-generation", "orphan-owner");
  expected.add("orphan-generation");
  // The lowercase Signal peer is a different conversation, not an alias.
  insert.run(
    "agent:main:signal:group:abc=",
    "different-peer",
    JSON.stringify({ sessionId: "different-peer", updatedAt: 1 }),
  );
  for (let index = 0; index < 100; index++) {
    const sessionId = `unrelated-${index}`;
    insert.run(
      `agent:main:dashboard:${sessionId}`,
      sessionId,
      JSON.stringify({
        sessionId,
        updatedAt: 1,
        skillsSnapshot: { prompt: "x".repeat(32_768), skills: [] },
      }),
    );
  }
  const storePath = "synthetic-admission-protection";
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities,
    assertAllowed: () => {},
  });
  onTestFinished(() => admission.release());
  expect(collectAdmissionProtectedSessionIds({ database: { db }, storePath })).toEqual(expected);
  expect(payloadReads).toBe(entries.length);
  admission.release();
  payloadReads = 0;
  expect(collectAdmissionProtectedSessionIds({ database: { db }, storePath })).toEqual(new Set());
  expect(payloadReads).toBe(0);
});

it.each(["UTF-8", "UTF-16le", "UTF-16be"] as const)(
  "preserves admission protection through raw %s key decoding",
  async (encoding) => {
    const db = new DatabaseSync(":memory:");
    onTestFinished(() => db.close());
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
      insert.run(bytes, sessionId, JSON.stringify({ sessionId, previousSessionId, updatedAt: 1 }));
      addWindow.run(`historical-${index}`, bytes);
      expected.add(sessionId).add(previousSessionId).add(`historical-${index}`);
    }
    const identities = db
      .prepare("SELECT session_key FROM session_nodes")
      .all()
      .map((row) => String(row.session_key));
    for (const identity of identities) {
      expected.add(identity);
    }
    const storePath = `synthetic-raw-admission-${encoding}`;
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities,
      assertAllowed: () => {},
    });
    onTestFinished(() => admission.release());

    expect(collectAdmissionProtectedSessionIds({ database: { db }, storePath })).toEqual(expected);
  },
);
