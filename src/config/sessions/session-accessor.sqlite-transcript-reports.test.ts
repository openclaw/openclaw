import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../../logging/secret-redaction-registry.test-support.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  appendSessionTranscriptReport,
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";
import { CURRENT_SESSION_VERSION } from "./version.js";

afterEach(() => {
  resetSecretRedactionRegistryForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

const body = "synthetic report content ".repeat(400);
const scope = { agentId: "main", sessionKey: "agent:main:reports", sessionId: "reports" };
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: body }],
  api: "openai-responses",
  provider: "openai",
  model: "synthetic",
  responseId: "response",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
} satisfies AssistantMessage;
const selected = { customType: "status", content: body, details: { selected: true } };

async function seedReports() {
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  await replaceTranscriptEvents(scope, [
    { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
    { type: "message", id: "root", parentId: null, message: { role: "user", content: body } },
    {
      type: "custom_message",
      id: "old",
      parentId: "root",
      customType: "status",
      content: body,
      display: true,
    },
    { type: "custom_message", id: "selected", parentId: "old", ...selected, display: true },
    {
      type: "message",
      id: "assistant",
      parentId: "selected",
      message: { ...assistant, __openclaw: { runId: "run" } },
    },
    {
      type: "message",
      id: "tail",
      parentId: "assistant",
      message: { role: "user", content: body },
    },
  ]);
  const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
  expect(
    db
      .prepare(
        "SELECT count(*) AS count FROM transcript_events WHERE session_id = ? AND event_zstd IS NOT NULL",
      )
      .get(scope.sessionId),
  ).toEqual({ count: 5 });
  return db;
}

function transcriptSnapshot(db: DatabaseSync) {
  return {
    events: db
      .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
      .all(scope.sessionId),
    watermark: db
      .prepare("SELECT * FROM transcript_rewrite_watermarks WHERE session_id = ?")
      .get(scope.sessionId),
  };
}

describe("SQLite report payload selection", () => {
  it.each(["custom", "run", "response"] as const)(
    "keeps %s reporting independent of unselected compressed bodies",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const db = await seedReports();
        // Unselected bodies are unavailable; their recorded navigation still supports report decisions.
        const changed = db
          .prepare(
            "UPDATE transcript_events SET event_zstd = x'010203' WHERE session_id = ? AND event_zstd IS NOT NULL AND seq != 3",
          )
          .run(scope.sessionId);
        expect(changed.changes).toBe(4);
        const before = transcriptSnapshot(db);
        const selectReport = vi.fn(() => undefined);
        const report: Parameters<typeof appendSessionTranscriptReport>[1] =
          kind === "response"
            ? { kind: "assistant", message: assistant }
            : {
                kind: "custom",
                customTypes: ["status"],
                suppressWhenAssistantRun: kind === "run" ? "run" : undefined,
                selectReport,
              };
        await expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({
          ok: true,
        });
        expect(transcriptSnapshot(db)).toEqual(before);
        if (kind === "custom") {
          expect(selectReport).toHaveBeenCalledExactlyOnceWith(selected);
        } else {
          expect(selectReport).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("reselects after another connection changes the report branch before commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const db = await seedReports();
      const hostTransactions = vi.spyOn(db, "exec");
      const { path } = openOpenClawAgentDatabase({ agentId: scope.agentId });
      const other = new DatabaseSync(path);
      const competitor = {
        customType: "status",
        content: "concurrent report",
        details: { revision: 2 },
      };
      const selectReport = vi.fn((latest: { content: unknown } | undefined) => {
        if (selectReport.mock.calls.length === 1) {
          // Force the actual selection-to-commit race without a timer or worker test hook.
          other
            .prepare(
              "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 6, ?, 1)",
            )
            .run(
              scope.sessionId,
              JSON.stringify({
                type: "custom_message",
                id: "competitor",
                parentId: "tail",
                ...competitor,
                display: true,
              }),
            );
        }
        return { customType: "status", content: String(latest?.content), display: true };
      });
      try {
        await expect(
          appendSessionTranscriptReport(scope, {
            kind: "custom",
            customTypes: ["status"],
            selectReport,
          }),
        ).resolves.toEqual({ ok: true, value: undefined });
      } finally {
        other.close();
      }
      expect(selectReport).toHaveBeenNthCalledWith(1, selected);
      expect(selectReport).toHaveBeenNthCalledWith(2, competitor);
      expect(selectReport).toHaveBeenCalledTimes(2);
      expect(hostTransactions.mock.calls.some(([sql]) => /^BEGIN\s+IMMEDIATE/i.test(sql))).toBe(
        false,
      );
      const events = await loadTranscriptEvents(scope);
      expect(events).toHaveLength(8);
      expect(events[7]).toMatchObject({
        type: "custom_message",
        parentId: "competitor",
        content: competitor.content,
      });
    });
  });

  it("preserves custom report JSON serialization before worker transfer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await seedReports();
      const serializedKeys: string[] = [];
      class NestedDetails {
        toJSON(key: string) {
          serializedKeys.push(key);
          return { revision: 3 };
        }
      }
      const details = {
        toJSON(key: string) {
          serializedKeys.push(key);
          return { nested: new NestedDetails(), omitted: undefined };
        },
      };
      await expect(
        appendSessionTranscriptReport(scope, {
          kind: "custom",
          customTypes: ["status"],
          selectReport: () => ({
            customType: "status",
            content: "serialized report",
            display: true,
            details,
            toJSON(key: string): unknown {
              serializedKeys.push(key);
              return { ...this, toJSON: undefined };
            },
          }),
        }),
      ).resolves.toEqual({ ok: true, value: undefined });
      expect(serializedKeys).toEqual(["", "details", "nested"]);
      const events = await loadTranscriptEvents(scope);
      expect(events.at(-1)).toMatchObject({
        type: "custom_message",
        parentId: "tail",
        content: "serialized report",
        details: { nested: { revision: 3 } },
      });
      expect(JSON.stringify(events.at(-1))).not.toContain("omitted");
    });
  });

  it("refuses malformed stored facts before selecting or appending a report", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const db = await seedReports();
      db.prepare(`UPDATE transcript_events SET navigation_json = json_set(navigation_json, '$.report', json(?))
        WHERE session_id = ? AND seq = 1`).run(
        JSON.stringify({
          kind: "canonical",
          hasParentId: true,
          entry: { id: "root", type: "message" },
        }),
        scope.sessionId,
      );
      const before = transcriptSnapshot(db);
      const selectReport = vi.fn(() => ({ ...selected, display: true }));
      await expect(
        appendSessionTranscriptReport(scope, {
          kind: "custom",
          customTypes: ["status"],
          selectReport,
        }),
      ).rejects.toThrow("Invalid compressed transcript report facts");
      expect(selectReport).not.toHaveBeenCalled();
      expect(transcriptSnapshot(db)).toEqual(before);
    });
  });

  it("does not let an unreadable compressed assistant suppress a real response", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const unreadable = {
        type: "message",
        id: "unreadable",
        parentId: null,
        message: { role: "assistant", content: null, responseId: assistant.responseId },
        padding: body,
      };
      await replaceTranscriptEvents(scope, [
        { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
        unreadable,
      ]);
      const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
      expect(
        db
          .prepare(
            "SELECT event_json IS NULL AS encoded FROM transcript_events WHERE session_id = ? AND seq = 1",
          )
          .get(scope.sessionId),
      ).toEqual({ encoded: 1 });
      const secret = "synthetic-report-redaction-registered-value";
      registerSecretValueForRedaction(secret);
      const reportMessage = {
        ...assistant,
        content: [{ type: "text" as const, text: `${body}${secret}` }],
      };
      await expect(
        appendSessionTranscriptReport(scope, { kind: "assistant", message: reportMessage }),
      ).resolves.toMatchObject({ ok: true });
      const events = await loadTranscriptEvents(scope);
      expect(events).toHaveLength(3);
      expect(events[1]).toEqual(unreadable);
      expect(JSON.stringify(events[2])).not.toContain(secret);
      expect(JSON.stringify(events[2])).toContain("synthe…alue");
      expect(events[2]).toMatchObject({
        type: "message",
        parentId: "unreadable",
        message: {
          responseId: assistant.responseId,
          content: [{ type: "text", text: expect.stringContaining(body) }],
        },
      });
    });
  });

  it("uses the first header and still parses identity rows after it", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const db = await seedReports();
      db.prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 6, ?, 1)",
      ).run(scope.sessionId, JSON.stringify({ type: "session", id: "later", version: 1 }));
      const selectReport = vi.fn(() => undefined);
      const report = { kind: "custom", customTypes: ["status"], selectReport } as const;
      await expect(appendSessionTranscriptReport(scope, report)).resolves.toMatchObject({
        ok: true,
      });
      expect(selectReport).toHaveBeenCalledExactlyOnceWith(selected);
      db.prepare(
        "UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 6",
      ).run(scope.sessionId);
      const before = transcriptSnapshot(db);
      selectReport.mockClear();
      await expect(appendSessionTranscriptReport(scope, report)).rejects.toThrow(SyntaxError);
      expect(selectReport).not.toHaveBeenCalled();
      expect(transcriptSnapshot(db)).toEqual(before);
    });
  });

  it("uses the last original duplicate member for response suppression", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const raw = `{"type":"message","id":"duplicate","parentId":null,
        "message":{"role":"assistant","content":${JSON.stringify(body)},"responseId":"first"},
        "message":{"role":"assistant","content":${JSON.stringify(body)},"responseId":"discarded","responseId":"last"}}`;
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(scope, [
        { type: "session", id: scope.sessionId, version: CURRENT_SESSION_VERSION },
        JSON.parse(raw),
      ]);
      const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId });
      const payload = prepareTranscriptPayload(db, raw);
      expect(payload.event_zstd).not.toBeNull();
      db.prepare(`UPDATE transcript_events
        SET event_json = ?, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ?
        WHERE session_id = ? AND seq = 1`).run(
        payload.event_json,
        payload.event_zstd,
        payload.event_utf8_bytes,
        payload.navigation_json,
        scope.sessionId,
      );
      const before = transcriptSnapshot(db);
      await expect(
        appendSessionTranscriptReport(scope, {
          kind: "assistant",
          message: { ...assistant, responseId: "last" },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(transcriptSnapshot(db)).toEqual(before);
      await expect(
        appendSessionTranscriptReport(scope, {
          kind: "assistant",
          message: { ...assistant, responseId: "first" },
        }),
      ).resolves.toMatchObject({ ok: true });
      const events = await loadTranscriptEvents(scope);
      expect(events).toHaveLength(3);
      expect(events[1]).toEqual(JSON.parse(raw));
      expect(events[2]).toMatchObject({
        type: "message",
        parentId: "duplicate",
        message: { responseId: "first" },
      });
      expect(transcriptSnapshot(db).events[1]).toEqual(before.events[1]);
    });
  });
});
