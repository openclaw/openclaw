import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { selectSessionTranscriptLeafControlledPath } from "../config/sessions/transcript-tree.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { readBeforeResetHookMessages } from "./session-reset-hook-messages.js";

// Public hook limits are asserted independently of production constants.
const BEFORE_RESET_HOOK_MAX_MESSAGES = 4096;
const BEFORE_RESET_HOOK_MAX_BYTES = 8 * 1024 * 1024;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function messageIds(messages: unknown[]) {
  return messages.map((entry) => (entry as { __openclaw: { id: string } })["__openclaw"].id);
}

describe("readBeforeResetHookMessages", () => {
  let tempDir: string;
  let storePath: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    tempDir = tempDirs.make("openclaw-before-reset-hook-");
    storePath = path.join(tempDir, "sessions.json");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  async function writeTranscript(
    sessionId: string,
    count: number,
    content = (i: number) => `turn ${i}`,
  ) {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath,
    };
    const events = Array.from({ length: count }, (_, index) => ({
      type: "message" as const,
      id: `m${index + 1}`,
      parentId: index === 0 ? null : `m${index}`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: content(index + 1) },
    }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: sessionId },
      ...events,
    ]);
    // Large replacements rebuild the transcript projection asynchronously.
    await waitForSessionTranscriptProjection(scope);
    return scope;
  }

  async function writeExact(sessionId: string, events: string[]) {
    const scope = { agentId: "main", sessionId, sessionKey: "agent:main:" + sessionId, storePath };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId, updatedAt: 1 },
      readExactTranscriptRows: (append) => {
        append({
          createdAt: 0,
          eventJson: JSON.stringify({ type: "session", version: 3, id: sessionId }),
        });
        events.forEach((eventJson, index) => append({ createdAt: index + 1, eventJson }));
      },
    });
    return scope;
  }

  test("delivers every message of a small session unchanged", async () => {
    const scope = await writeTranscript("small", 3);
    const payload = await readBeforeResetHookMessages(scope);
    expect(messageIds(payload.messages)).toEqual(["m1", "m2", "m3"]);
    expect(payload.totalMessages).toBe(3);
    expect(payload.truncated).toBe(false);
  });

  test("keeps only the newest messages of a session above the count bound", async () => {
    const extra = 50;
    const scope = await writeTranscript("large", BEFORE_RESET_HOOK_MAX_MESSAGES + extra);
    const payload = await readBeforeResetHookMessages(scope);
    expect(payload.messages).toHaveLength(BEFORE_RESET_HOOK_MAX_MESSAGES);
    const ids = messageIds(payload.messages);
    expect(ids[0]).toBe(`m${extra + 1}`);
    expect(ids.at(-1)).toBe(`m${BEFORE_RESET_HOOK_MAX_MESSAGES + extra}`);
    expect(payload.totalMessages).toBe(BEFORE_RESET_HOOK_MAX_MESSAGES + extra);
    expect(payload.truncated).toBe(true);
  });

  test("keeps the newest messages within the byte bound", async () => {
    const count = 20;
    const oneMebibyte = "x".repeat(1024 * 1024);
    const scope = await writeTranscript("bulky", count, () => oneMebibyte);
    const payload = await readBeforeResetHookMessages(scope);
    expect(payload.messages.length).toBeGreaterThan(0);
    expect(payload.messages.length).toBeLessThan(count);
    expect(Buffer.byteLength(JSON.stringify(payload.messages), "utf8")).toBeLessThanOrEqual(
      BEFORE_RESET_HOOK_MAX_BYTES,
    );
    expect(messageIds(payload.messages).at(-1)).toBe(`m${count}`);
    expect(payload.totalMessages).toBe(count);
    expect(payload.truncated).toBe(true);
  });

  test("fires with an empty payload when the session identity is incomplete", async () => {
    await expect(
      readBeforeResetHookMessages({ agentId: "main", sessionKey: "agent:main:x", storePath }),
    ).resolves.toEqual({ messages: [], totalMessages: 0, truncated: false });
    await expect(
      readBeforeResetHookMessages({ agentId: "main", sessionId: "x", sessionKey: "agent:main:x" }),
    ).resolves.toEqual({ messages: [], totalMessages: 0, truncated: false });
  });

  test("fires with an empty payload when the transcript cannot be read", async () => {
    const payload = await readBeforeResetHookMessages({
      agentId: "main",
      sessionId: "missing",
      sessionKey: "agent:main:missing",
      storePath,
    });
    expect(payload).toEqual({ messages: [], totalMessages: 0, truncated: false });
  });

  test.each(["display", "raw"] as const)(
    "rejects an oversized newest %s row before parsing",
    async (selection) => {
      const scope = await writeTranscript("oversized", 1, () =>
        "x".repeat(BEFORE_RESET_HOOK_MAX_BYTES + 1),
      );
      const parse = JSON.parse;
      const oversizedReads: number[] = [];
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (Buffer.byteLength(text, "utf8") > BEFORE_RESET_HOOK_MAX_BYTES) {
          oversizedReads.push(text.length);
        }
        return parse(text, reviver);
      });
      try {
        expect(await readBeforeResetHookMessages(scope, selection)).toEqual({
          messages: [],
          totalMessages: 1,
          truncated: true,
        });
        expect(oversizedReads).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    },
  );

  test("does not share mutable empty payloads between observers", async () => {
    const first = await readBeforeResetHookMessages({});
    first.messages.push({ private: "previous observer" });
    expect(await readBeforeResetHookMessages({})).toEqual({
      messages: [],
      totalMessages: 0,
      truncated: false,
    });
  });

  test.each([false, true])(
    "preserves raw command membership across reset, compaction and custom records (leaf=%s)",
    async (withLeaf) => {
      const scope = await writeTranscript("membership", 0);
      const message = (id: string, parentId: string | null) => ({
        type: "message",
        id,
        parentId,
        message: { role: "user", content: id },
      });
      const events = [
        { type: "session", version: 3, id: scope.sessionId },
        message("before", null),
        { type: "reset", id: "reset", parentId: "before", reason: "new" },
        message("after", "reset"),
        {
          type: "compaction",
          id: "compact",
          parentId: "after",
          summary: "summary",
          firstKeptEntryId: "after",
          tokensBefore: 10,
        },
        {
          type: "custom_message",
          id: "custom",
          parentId: "compact",
          customType: "notice",
          display: true,
          content: "custom",
        },
        message("latest", "custom"),
        ...(withLeaf
          ? [
              message("discarded", "latest"),
              { type: "leaf", id: "leaf", parentId: "discarded", targetId: "latest" },
            ]
          : []),
      ];
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptProjection(scope);
      const raw = await loadTranscriptEvents(scope);
      const expected = (selectSessionTranscriptLeafControlledPath(raw) ?? raw).flatMap((row) => {
        const entry = asOptionalRecord(row);
        return entry?.type === "message" && entry.message ? [entry.message] : [];
      });
      const result = await readBeforeResetHookMessages(scope, "raw");
      expect(result.messages).toEqual(expected);
      expect(result.messages).toEqual(
        ["before", "after", "latest"].map((content) => ({ role: "user", content })),
      );
      expect(result.totalMessages).toBe(expected.length);
      expect(result.truncated).toBe(false);
    },
  );

  test("preserves flat storage membership without leaf controls", async () => {
    const scope = await writeTranscript("flat", 0);
    const messages = ["root", "branch-a", "branch-b"].map((content) => ({ role: "user", content }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      { type: "message", id: "root", parentId: null, message: messages[0] },
      { type: "message", id: "a", parentId: "root", message: messages[1] },
      { type: "message", id: "b", parentId: "root", message: messages[2] },
    ]);
    await waitForSessionTranscriptProjection(scope);
    expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
      messages,
      totalMessages: 3,
      truncated: false,
    });
  });
  test("excludes missing and falsy raw payloads before counting and limiting", async () => {
    const scope = await writeTranscript("falsy", 0);
    const valid = { role: "user", content: "keep me" };
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      { type: "message", id: "valid", message: valid },
      ...Array.from({ length: 4100 }, (_, i) => ({
        type: "message",
        id: "null-" + i,
        message: null,
      })),
      { type: "message", id: "missing" },
      { type: "message", id: "empty", message: "" },
      { type: "message", id: "false", message: false },
      { type: "message", id: "zero", message: 0 },
    ]);
    await waitForSessionTranscriptProjection(scope);
    expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
      messages: [valid],
      totalMessages: 1,
      truncated: false,
    });
  });
  test.each([
    { name: "missing target", targetId: "missing" },
    { name: "missing append parent", targetId: "root", appendParentId: "missing" },
    { name: "future target", targetId: "future" },
  ])(
    "ignores an unaccepted leaf control ($name) when selecting raw hook messages",
    async (control) => {
      const scope = await writeTranscript("dangling-leaf", 0);
      const events = [
        { type: "session", version: 3, id: scope.sessionId },
        { type: "message", id: "root", parentId: null, message: { role: "user", content: "root" } },
        { type: "message", id: "a", parentId: "root", message: { role: "user", content: "a" } },
        { type: "message", id: "b", parentId: "root", message: { role: "user", content: "b" } },
        {
          type: "leaf",
          id: "invalid",
          parentId: "b",
          targetId: control.targetId,
          ...("appendParentId" in control ? { appendParentId: control.appendParentId } : {}),
        },
        { type: "custom", id: "future", parentId: "b" },
      ];
      await replaceTranscriptEvents(scope, events);
      await waitForSessionTranscriptProjection(scope);
      const raw = await loadTranscriptEvents(scope);
      expect(selectSessionTranscriptLeafControlledPath(raw)).toBeUndefined();
      expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
        messages: ["root", "a", "b"].map((content) => ({ role: "user", content })),
        totalMessages: 3,
        truncated: false,
      });
    },
  );
  test.each([
    { state: "dirty", leaf: false },
    { state: "missing", leaf: false },
    { state: "lagging", leaf: false },
    { state: "dirty", leaf: true },
    { state: "missing", leaf: true },
    { state: "lagging", leaf: true },
  ])(
    "captures raw command preparation with a $state projection (leaf=$leaf)",
    async ({ state, leaf }) => {
      const scope = await writeTranscript("pending-index", 3);
      if (leaf) {
        const raw = await loadTranscriptEvents(scope);
        await replaceTranscriptEvents(scope, [
          ...raw,
          { type: "leaf", id: "selected", parentId: "m3", targetId: "m1" },
        ]);
      }
      const options = toDatabaseOptions(resolveSqliteTranscriptReadScope(scope));
      const database = openOpenClawAgentDatabase(options);
      if (state === "missing") {
        database.db
          .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
          .run(scope.sessionId);
      } else if (state === "lagging") {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET indexed_seq = -1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      } else {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }
      const { readBeforeResetMessages } =
        await import("../auto-reply/reply/commands-reset-hooks.js");
      try {
        // Mirror reset preparation's writer admission. No readiness wait precedes
        // capture, and an attempted wait inside this callback would deadlock.
        const payload = await runOpenClawAgentWriteAdmission(options, () =>
          readBeforeResetMessages(scope),
        );
        expect(payload).toEqual({
          messages: Array.from({ length: leaf ? 1 : 3 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: "turn " + (index + 1),
          })),
          totalMessages: leaf ? 1 : 3,
          truncated: false,
        });
      } finally {
        // Drain only after the preparation reader has returned and released its
        // writer admission; this is cleanup, not fixture readiness for the test.
        await waitForSessionTranscriptProjection(scope);
      }
    },
  );
  test("counts raw messages without a per-row identity join", async () => {
    const scope = await writeTranscript("raw-query-plan", 20);
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const prepare = vi.spyOn(database.db, "prepare");
    let countSql: string | undefined;
    try {
      expect((await readBeforeResetHookMessages(scope, "raw")).messages).toHaveLength(20);
      countSql = prepare.mock.calls
        .map(([statement]) => statement)
        .find((statement) =>
          statement.startsWith('select count(*) as "count" from "transcript_events" as "event"'),
        );
    } finally {
      prepare.mockRestore();
    }
    expect(countSql).toBeDefined();
    if (!countSql) {
      throw new Error("Missing raw hook count query");
    }
    const plan = database.db
      .prepare("EXPLAIN QUERY PLAN " + countSql)
      .all(...Array.from({ length: countSql.match(/\?/g)?.length ?? 0 }, () => null));
    expect(
      plan.some((row) => {
        const detail = asOptionalRecord(row)?.detail;
        return typeof detail === "string" && detail.includes("transcript_event_identities");
      }),
    ).toBe(false);
  });
  test.each([
    '{"type":"message","message":null,"message":{"role":"user","content":"last"}}',
    '{"type":"message","message":{"role":"user","content":"first"},"message":null}',
    '{"type":"opaque","type":"message","message":{"role":"user","content":"last type"}}',
    '{"type":"message","type":"opaque","message":{"role":"user","content":"not a message"}}',
    '{"type":"message","message":"","message":"last string"}',
  ])("parser compatibility keeps the last duplicate member %#", async (raw) => {
    const scope = await writeExact("duplicates", [raw]);
    const parsed = asOptionalRecord(JSON.parse(raw));
    const expected = parsed?.type === "message" && parsed.message ? [parsed.message] : [];
    expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
      messages: expected,
      totalMessages: expected.length,
      truncated: false,
    });
  });

  test.each([
    { name: "SQLite overdepth array", json: "[".repeat(1001) + "0" + "]".repeat(1001) },
    { name: "deep integer-key object", json: '{"0":'.repeat(10000) + "0" + "}".repeat(10000) },
    {
      name: "non-callable toJSON and deep array",
      json: '{"toJSON":null,"value":' + "[".repeat(10000) + "0" + "]".repeat(10000) + "}",
    },
  ])("parser compatibility retains $name below the byte limit", async ({ json }) => {
    const raw =
      '{"type":"message","id":"deep","parentId":"root","message":{"role":"user","content":' +
      json +
      "}}";
    const scope = await writeExact("deep", [
      '{"type":"message","id":"root","parentId":null,"message":{"role":"user","content":"root"}}',
      raw,
    ]);
    expect(Buffer.byteLength(raw)).toBeLessThan(BEFORE_RESET_HOOK_MAX_BYTES);
    const payload = await readBeforeResetHookMessages(scope, "raw");
    expect(payload.messages).toHaveLength(2);
    expect(payload.totalMessages).toBe(2);
    expect(payload.truncated).toBe(false);
    expect(asOptionalRecord(payload.messages[1])?.role).toBe("user");
  });

  test("parser compatibility enforces emitted bytes after numeric expansion", async () => {
    const raw =
      '{"type":"message","message":{"role":"user","content":[' +
      Array.from({ length: 390000 }, () => "1e20").join(",") +
      "]}}";
    expect(Buffer.byteLength(raw)).toBeLessThan(BEFORE_RESET_HOOK_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(raw).message))).toBeGreaterThan(
      BEFORE_RESET_HOOK_MAX_BYTES,
    );
    const scope = await writeExact("numeric-expansion", [raw]);
    expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
      messages: [],
      totalMessages: 1,
      truncated: true,
    });
  });

  test("parser compatibility does not hydrate oversized deep JSON or invent a count", async () => {
    const raw =
      '{"type":"message","message":{"content":' +
      "[".repeat(1001) +
      '"' +
      "x".repeat(BEFORE_RESET_HOOK_MAX_BYTES) +
      '"' +
      "]".repeat(1001) +
      "}}";
    const scope = await writeExact("deep-oversized", [raw]);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(await readBeforeResetHookMessages(scope, "raw")).toEqual({
        messages: [],
        truncated: true,
      });
      expect(
        parse.mock.calls.some(
          ([value]) =>
            typeof value === "string" && Buffer.byteLength(value) > BEFORE_RESET_HOOK_MAX_BYTES,
        ),
      ).toBe(false);
    } finally {
      parse.mockRestore();
    }
  });

  test("parser compatibility preserves deep bodies and duplicate leaf targets during rebuild", async () => {
    const deep = "[".repeat(1001) + "0" + "]".repeat(1001);
    const scope = await writeExact("deep-leaf", [
      '{"type":"message","id":"wrong","id":"root","parentId":null,"message":{"role":"user","content":"root"}}',
      '{"type":"message","id":"side","parentId":"root","message":{"role":"user","content":"side"}}',
      '{"type":"message","id":"deep","parentId":"root","message":{"role":"user","content":' +
        deep +
        "}}",
      '{"type":"leaf","id":"nav","parentId":"deep","targetId":"side","targetId":"deep"}',
    ]);
    try {
      const payload = await readBeforeResetHookMessages(scope, "raw");
      expect(payload.messages).toHaveLength(2);
      expect(asOptionalRecord(payload.messages[0])?.content).toBe("root");
      expect(Array.isArray(asOptionalRecord(payload.messages[1])?.content)).toBe(true);
      expect(payload.totalMessages).toBe(2);
      expect(payload.truncated).toBe(false);
    } finally {
      await waitForSessionTranscriptProjection(scope);
    }
    expect((await readBeforeResetHookMessages(scope, "raw")).messages).toHaveLength(2);
  });
  test("parser compatibility restores exact duplicate and deep JSON from cold storage", async () => {
    const { createSessionColdStorageFixture, maintenanceConfig } =
      await import("../config/sessions/session-cold-storage.test-support.js");
    const { runSessionColdStorageMaintenance } =
      await import("../config/sessions/session-cold-storage.js");
    const fixture = await createSessionColdStorageFixture(
      path.join(tempDir, "cold", "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    const row = asOptionalRecord(
      fixture
        .database()
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 1")
        .get(fixture.scope.sessionId),
    );
    if (typeof row?.event_json !== "string") {
      throw new Error("Missing cold fixture message");
    }
    const raw =
      '{"message":null,' +
      row.event_json.slice(1, -1) +
      ',"opaque":' +
      "[".repeat(1001) +
      "0" +
      "]".repeat(1001) +
      "}";
    fixture
      .database()
      .prepare("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1")
      .run(raw, fixture.scope.sessionId);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toMatchObject({ archivedTranscripts: 1 });
    expect(
      fixture
        .database()
        .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(fixture.scope.sessionId),
    ).toEqual({ count: 0 });
    const payload = await readBeforeResetHookMessages(fixture.scope, "raw");
    expect(payload.messages).toHaveLength(2);
    expect(payload.totalMessages).toBe(2);
    expect(payload.truncated).toBe(false);
    expect(
      fixture
        .database()
        .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? AND seq = 1")
        .get(fixture.scope.sessionId),
    ).toEqual({ event_json: raw });
  });

  test("parser compatibility excludes later oversized rows before fallback classification", async () => {
    const scope = await writeTranscript("parser-fence", 3);
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const { readActiveTranscriptEntryAnchor } =
      await import("../config/sessions/session-accessor.sqlite-transcript-anchor.js");
    const { runWithSessionTranscriptReadFence } =
      await import("../config/sessions/session-transcript-read-fence.js");
    const anchor = readActiveTranscriptEntryAnchor({
      ...scope,
      storePath: database.path,
      entryId: "m3",
    });
    if (!anchor) {
      throw new Error("Missing admitted fixture anchor");
    }
    const raw =
      '{"type":"message","message":' +
      "[".repeat(1001) +
      '"' +
      "x".repeat(BEFORE_RESET_HOOK_MAX_BYTES) +
      '"' +
      "]".repeat(1001) +
      "}";
    database.db
      .prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(scope.sessionId, anchor.rawSeq + 1, raw, 10);
    const payload = await runWithSessionTranscriptReadFence(
      { ...anchor, logicalTurnId: "parser-fence", role: "user" },
      () => readBeforeResetHookMessages(scope, "raw"),
    );
    expect(payload).toEqual({
      messages: [
        { role: "user", content: "turn 1" },
        { role: "assistant", content: "turn 2" },
      ],
      totalMessages: 2,
      truncated: false,
    });
  });
  test("fenced raw snapshots ignore later duplicate IDs in the ready projection", async () => {
    const scope = await writeTranscript("fenced-leaf-membership", 0);
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      {
        type: "message",
        id: "m1",
        parentId: null,
        message: { role: "user", content: "before root" },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        message: { role: "assistant", content: "before branch" },
      },
      { type: "leaf", id: "initial", parentId: "m2", targetId: "m2" },
      {
        type: "message",
        id: "admitted",
        parentId: "m2",
        message: { role: "user", content: "current turn" },
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const { readActiveTranscriptEntryAnchor } =
      await import("../config/sessions/session-accessor.sqlite-transcript-anchor.js");
    const { runWithSessionTranscriptReadFence } =
      await import("../config/sessions/session-transcript-read-fence.js");
    const { reconcileSessionTranscriptIndexes } =
      await import("../config/sessions/session-transcript-reconcile.js");
    const anchor = readActiveTranscriptEntryAnchor({
      ...scope,
      storePath: database.path,
      entryId: "admitted",
    });
    if (!anchor) {
      throw new Error("Missing current admission anchor");
    }
    // Exact retained rows can contain duplicate IDs without append normalization.
    const append = database.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    append.run(
      scope.sessionId,
      anchor.rawSeq + 1,
      JSON.stringify({
        type: "message",
        id: "m2",
        parentId: "m1",
        appendMode: "side",
        message: { role: "assistant", content: "future replacement" + "x".repeat(2000) },
      }),
      10,
    );
    append.run(
      scope.sessionId,
      anchor.rawSeq + 2,
      JSON.stringify({ type: "leaf", id: "future", parentId: "m2", targetId: "admitted" }),
      11,
    );
    await reconcileSessionTranscriptIndexes({
      ...toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      preferredSessionId: scope.sessionId,
    });
    expect(
      readActiveTranscriptEntryAnchor({ ...scope, storePath: database.path, entryId: "admitted" }),
    ).toEqual(anchor);
    const { readSessionTranscriptHookMessages } =
      await import("../config/sessions/session-accessor.sqlite-hook-messages.js");
    const contents = (messages: unknown[]) =>
      messages.map((message) => {
        const content = asOptionalRecord(message)?.content;
        return typeof content === "string" ? content.slice(0, 18) : content;
      });
    expect(contents((await readBeforeResetHookMessages(scope, "raw")).messages)).toEqual([
      "before root",
      "future replacement",
      "current turn",
    ]);
    expect(
      contents(
        (await readSessionTranscriptHookMessages(scope, { maxMessages: 4096, maxBytes: 1800 }))
          .messages,
      ),
    ).toEqual(["current turn"]);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    try {
      const fallback = await runOpenClawAgentWriteAdmission(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
        () => readSessionTranscriptHookMessages(scope, { maxMessages: 4096, maxBytes: 1800 }),
      );
      expect(contents(fallback.messages)).toEqual(["current turn"]);
    } finally {
      await waitForSessionTranscriptProjection(scope);
    }
    const payload = await runWithSessionTranscriptReadFence(
      { ...anchor, logicalTurnId: "fenced-leaf-membership", role: "user" },
      () => readBeforeResetHookMessages(scope, "raw"),
    );
    expect(payload).toEqual({
      messages: [
        { role: "user", content: "before root" },
        { role: "assistant", content: "before branch" },
      ],
      totalMessages: 2,
      truncated: false,
    });
  });
  test.each([{ maxMessages: 100, maxBytes: 100 }])(
    "canonical navigation storage has a cumulative byte budget %#",
    async (limits) => {
      const scope = await writeTranscript("navigation-budget", 0);
      await replaceTranscriptEvents(scope, [
        { type: "session", version: 3, id: scope.sessionId },
        { type: "message", id: "a", parentId: null, message: { role: "user", content: "a" } },
        { type: "message", id: "b", parentId: "a", message: { role: "user", content: "b" } },
        { type: "leaf", id: "leaf", parentId: "b", targetId: "b" },
      ]);
      await waitForSessionTranscriptProjection(scope);
      const { readSessionTranscriptHookMessages } =
        await import("../config/sessions/session-accessor.sqlite-hook-messages.js");
      expect(await readSessionTranscriptHookMessages(scope, limits)).toEqual({
        messages: [],
        truncated: true,
      });
    },
  );

  test("fenced navigation does not confuse metadata rows with the message count limit", async () => {
    const scope = await writeTranscript("fenced-navigation-budget", 0);
    await replaceTranscriptEvents(scope, [
      { type: "session", version: 3, id: scope.sessionId },
      { type: "message", id: "a", parentId: null, message: { role: "user", content: "a" } },
      { type: "leaf", id: "leaf", parentId: "a", targetId: "a" },
      { type: "message", id: "b", parentId: "a", message: { role: "user", content: "b" } },
      {
        type: "message",
        id: "admitted",
        parentId: "b",
        message: { role: "user", content: "current" },
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
    );
    const { readActiveTranscriptEntryAnchor } =
      await import("../config/sessions/session-accessor.sqlite-transcript-anchor.js");
    const { runWithSessionTranscriptReadFence } =
      await import("../config/sessions/session-transcript-read-fence.js");
    const { readSessionTranscriptHookMessages } =
      await import("../config/sessions/session-accessor.sqlite-hook-messages.js");
    const anchor = readActiveTranscriptEntryAnchor({
      ...scope,
      storePath: database.path,
      entryId: "admitted",
    });
    if (!anchor) {
      throw new Error("Missing navigation budget anchor");
    }
    expect(
      await runWithSessionTranscriptReadFence(
        { ...anchor, logicalTurnId: "navigation-budget", role: "user" },
        () =>
          readSessionTranscriptHookMessages(scope, {
            maxMessages: 3,
            maxBytes: BEFORE_RESET_HOOK_MAX_BYTES,
          }),
      ),
    ).toEqual({
      messages: [
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ],
      totalMessages: 2,
      truncated: false,
    });
  });
  test.each(["early", "late", "branched", "fenced"])(
    "retains the useful tail of a 20k %s leaf-controlled history",
    async (placement) => {
      const scope = await writeTranscript("large-leaf-" + placement, 0);
      const id = (i: number) =>
        placement === "branched" || placement === "fenced"
          ? "00000000-0000-0000-0000-" + String(i).padStart(12, "0")
          : "m" + i;
      const events = Array.from({ length: 20000 }, (_, i) => ({
        type: "message",
        id: id(i),
        parentId: i === 0 ? null : id(i - 1),
        message: { role: i % 2 ? "assistant" : "user", content: "turn " + i },
      }));
      const leaf = {
        type: "leaf",
        id: "noop",
        parentId: placement === "late" ? id(19999) : id(0),
        targetId: placement === "late" ? id(19999) : id(0),
      };
      const rows: unknown[] = [{ type: "session", version: 3, id: scope.sessionId }, ...events];
      if (placement === "branched") {
        rows.splice(2, 0, {
          type: "message",
          id: "discarded",
          parentId: id(0),
          message: { role: "assistant", content: "inactive branch" },
        });
        rows.splice(3, 0, { ...leaf, parentId: "discarded" });
      } else {
        rows.splice(placement === "late" ? rows.length : 2, 0, leaf);
      }
      if (placement === "fenced") {
        rows.push({
          type: "message",
          id: "admitted",
          parentId: id(19999),
          message: { role: "user", content: "current command" },
        });
      }
      await replaceTranscriptEvents(scope, rows);
      await waitForSessionTranscriptProjection(scope);
      let result;
      if (placement === "fenced") {
        const database = openOpenClawAgentDatabase(
          toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
        );
        const { readActiveTranscriptEntryAnchor } =
          await import("../config/sessions/session-accessor.sqlite-transcript-anchor.js");
        const { runWithSessionTranscriptReadFence } =
          await import("../config/sessions/session-transcript-read-fence.js");
        const anchor = readActiveTranscriptEntryAnchor({
          ...scope,
          storePath: database.path,
          entryId: "admitted",
        });
        if (!anchor) {
          throw new Error("Missing large fenced anchor");
        }
        result = await runWithSessionTranscriptReadFence(
          { ...anchor, logicalTurnId: "large-leaf", role: "user" },
          () => readBeforeResetHookMessages(scope, "raw"),
        );
      } else {
        result = await readBeforeResetHookMessages(scope, "raw");
      }
      console.log(
        "LARGE_LEAF",
        placement,
        JSON.stringify({
          count: result.messages.length,
          totalMessages: result.totalMessages,
          truncated: result.truncated,
        }),
      );
      expect(result.messages).toHaveLength(4096);
      expect(result.totalMessages).toBe(20000);
      expect(result.truncated).toBe(true);
      expect(asOptionalRecord(result.messages[0])?.content).toBe("turn 15904");
      expect(asOptionalRecord(result.messages.at(-1))?.content).toBe("turn 19999");
    },
  );
  test("charges only retained navigation for an already bounded deep fallback body", async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({
        type: "message",
        id: "m" + i,
        parentId: i ? "m" + (i - 1) : null,
        message: { role: "user", content: "turn " + i },
      }),
    );
    rows[11] =
      '{"type":"message","id":"m11","parentId":"m10","message":{"role":"user","content":' +
      "[".repeat(1001) +
      "0" +
      "]".repeat(1001) +
      "}}";
    rows.splice(1, 0, '{"type":"leaf","id":"leaf","parentId":"m0","targetId":"m0"}');
    const scope = await writeExact("retained-deep-budget", rows);
    const { readSessionTranscriptHookMessages } =
      await import("../config/sessions/session-accessor.sqlite-hook-messages.js");
    const result = await readSessionTranscriptHookMessages(scope, {
      maxMessages: 4096,
      maxBytes: 3500,
    });
    expect(result.totalMessages).toBe(12);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(Array.isArray(asOptionalRecord(result.messages.at(-1))?.content)).toBe(true);
  });
  test("an early rejected leaf does not force navigation of a 50k flat suffix", async () => {
    const scope = await writeTranscript("large-rejected-leaf", 0);
    const rows: unknown[] = [
      { type: "session", version: 3, id: scope.sessionId },
      ...Array.from({ length: 50000 }, (_, i) => ({
        type: "message",
        id: "m" + i,
        parentId: i ? "m" + (i - 1) : null,
        message: { role: "user", content: "turn " + i },
      })),
    ];
    rows.splice(2, 0, { type: "leaf", id: "dangling", parentId: "m0", targetId: "absent" });
    await replaceTranscriptEvents(scope, rows);
    await waitForSessionTranscriptProjection(scope);
    const result = await readBeforeResetHookMessages(scope, "raw");
    expect(result.messages).toHaveLength(4096);
    expect(result.totalMessages).toBe(50000);
    expect(result.truncated).toBe(true);
    expect(asOptionalRecord(result.messages[0])?.content).toBe("turn 45904");
    expect(asOptionalRecord(result.messages.at(-1))?.content).toBe("turn 49999");
  });
});
