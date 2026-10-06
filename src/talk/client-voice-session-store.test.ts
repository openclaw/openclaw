import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { readOpenVoiceSessions } from "./client-voice-session-lookup.worker.js";
import {
  parseStoredVoiceSessionRecord,
  readVoiceSessionFacts,
  readVoiceSessionRecordInTransaction,
  VOICE_SESSION_RECORD_VERSION,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

function storedRecord(transcriptFailureKeys: unknown): string {
  return JSON.stringify({
    version: VOICE_SESSION_RECORD_VERSION,
    voiceSessionId: "voice-1",
    agentId: "main",
    sessionKey: "agent:main:main",
    origin: "client",
    status: "open",
    createdAt: 1,
    updatedAt: 1,
    consultRunIds: [],
    effects: [],
    transcriptFailureKeys,
  });
}

describe("client voice session store", () => {
  it("preserves cache custody columns across rejected updates and a successful retry", async () => {
    const home = await createTempHomeEnv("openclaw-voice-store-");
    const scope = "talk-client-voice-sessions";
    try {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const original = parseStoredVoiceSessionRecord(storedRecord([]));
      if (!original) {
        throw new Error("expected a valid voice record");
      }
      const write = (updatedAt: number) =>
        runOpenClawAgentWriteTransaction(
          (owner) => writeVoiceSessionRecordInTransaction(owner, { ...original, updatedAt }),
          { agentId: "main" },
        );
      write(1);
      database.db
        .prepare("UPDATE cache_entries SET blob = ?, expires_at = ? WHERE scope = ? AND key = ?")
        .run(Buffer.from([0, 255, 4]), 123, scope, original.voiceSessionId);
      const read = () =>
        database.db
          .prepare(
            "SELECT value_json, hex(blob) AS blob, expires_at FROM cache_entries WHERE scope = ? AND key = ?",
          )
          .get(scope, original.voiceSessionId);
      const before = read();
      database.db.exec(`CREATE TEMP TRIGGER reject_voice_update BEFORE UPDATE ON main.cache_entries
        WHEN NEW.scope = 'talk-client-voice-sessions' AND NEW.updated_at = 2
        BEGIN SELECT RAISE(ABORT, 'synthetic voice update failure'); END`);
      expect(() => write(2)).toThrow("synthetic voice update failure");
      expect(database.db.isTransaction).toBe(false);
      expect(read()).toEqual(before);
      database.db.exec("DROP TRIGGER reject_voice_update");
      write(3);
      expect(read()).toEqual({
        value_json: JSON.stringify({ ...original, updatedAt: 3 }),
        blob: "00FF04",
        expires_at: 123,
      });
      expect(readVoiceSessionRecordInTransaction(database, original.voiceSessionId)).toEqual({
        ...original,
        updatedAt: 3,
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await home.restore();
    }
  });

  it("filters open lookup candidates in SQL before decoding payloads", async () => {
    const home = await createTempHomeEnv("openclaw-voice-lookups-");
    try {
      const options = { agentId: "main" };
      const database = openOpenClawAgentDatabase(options);
      const base = JSON.parse(storedRecord([]));
      const rows = [
        { voiceSessionId: "selected" },
        { voiceSessionId: "closed", status: "closed" },
        { voiceSessionId: "other", sessionKey: "agent:main:other" },
        { voiceSessionId: "relay", origin: "relay" },
        { voiceSessionId: "foreign", agentId: "other" },
        { voiceSessionId: "recent", sessionKey: "agent:main:recent", updatedAt: 10 },
        { voiceSessionId: "excluded", sessionKey: "agent:main:excluded" },
        { voiceSessionId: "invalid", version: 2 },
      ].map((patch) => Object.assign({}, base, patch));
      const insert = database.db.prepare(
        "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
      );
      for (const row of rows) {
        insert.run(
          "talk-client-voice-sessions",
          row.voiceSessionId,
          JSON.stringify(row),
          row.updatedAt,
        );
      }
      insert.run("talk-client-voice-sessions", "malformed", "{broken", 1);
      insert.run("unrelated-cache", "other", "not JSON", 1);
      const parse = vi.spyOn(JSON, "parse");
      try {
        expect(
          readOpenVoiceSessions(options, {
            kind: "legacy",
            agentId: "main",
            sessionKey: "agent:main:main",
          }).matches,
        ).toEqual([{ voiceSessionId: "selected", sessionKey: "agent:main:main" }]);
        const decoded = () =>
          parse.mock.calls
            .map(([value]) => value)
            .filter((value) => value.includes('"voiceSessionId"'));
        expect(decoded()).toEqual(
          expect.arrayContaining([JSON.stringify(rows[0]), JSON.stringify(rows[7])]),
        );
        expect(decoded()).toHaveLength(2);
        parse.mockClear();
        expect(
          readOpenVoiceSessions(options, {
            kind: "stale",
            agentId: "main",
            updatedBefore: 1,
            excludeVoiceSessionId: "excluded",
          })
            .matches.map((row) => row.voiceSessionId)
            .toSorted(),
        ).toEqual(["foreign", "other", "relay", "selected"]);
        expect(decoded()).toHaveLength(5);
        for (const row of [rows[1], rows[5], rows[6]]) {
          expect(decoded()).not.toContain(JSON.stringify(row));
        }
      } finally {
        parse.mockRestore();
      }
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await home.restore();
    }
  });

  it("refreshes tool facts after local writes, rollback, and foreign commits", async () => {
    const home = await createTempHomeEnv("openclaw-voice-facts-");
    try {
      const options = { agentId: "main" };
      const database = openOpenClawAgentDatabase(options);
      const original = parseStoredVoiceSessionRecord(storedRecord([]))!;
      const write = (patch: Partial<typeof original>) =>
        runOpenClawAgentWriteTransaction(
          (owner) => writeVoiceSessionRecordInTransaction(owner, { ...original, ...patch }),
          options,
        );
      write({});
      const first = readVoiceSessionFacts("main", "voice-1");
      expect(first).toMatchObject({ status: "open" });
      expect(() =>
        runOpenClawAgentWriteTransaction((owner) => {
          writeVoiceSessionRecordInTransaction(owner, { ...original, status: "closed" });
          throw new Error("synthetic rollback");
        }, options),
      ).toThrow("synthetic rollback");
      expect(readVoiceSessionFacts("main", "voice-1")).toMatchObject({ status: "open" });
      write({ transcriptCapable: true });
      expect(readVoiceSessionFacts("main", "voice-1")).toMatchObject({ transcriptCapable: true });
      const foreign = new DatabaseSync(database.path);
      try {
        foreign
          .prepare("UPDATE cache_entries SET value_json = ? WHERE scope = ? AND key = ?")
          .run(
            JSON.stringify({ ...original, status: "closed", hasUserTranscript: true }),
            "talk-client-voice-sessions",
            "voice-1",
          );
      } finally {
        foreign.close();
      }
      expect(readVoiceSessionFacts("main", "voice-1")).toMatchObject({
        status: "closed",
        hasUserTranscript: true,
      });
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      await home.restore();
    }
  });

  it("defaults unresolved transcript failures for existing records", () => {
    expect(
      parseStoredVoiceSessionRecord(
        JSON.stringify({
          version: VOICE_SESSION_RECORD_VERSION,
          voiceSessionId: "voice-1",
          agentId: "main",
          sessionKey: "agent:main:main",
          origin: "client",
          status: "open",
          createdAt: 1,
          updatedAt: 1,
          consultRunIds: [],
          effects: [],
        }),
      )?.transcriptFailureKeys,
    ).toEqual([]);
  });

  it("rejects malformed, duplicate, or over-cap unresolved transcript failures", () => {
    const key = "a".repeat(64);
    expect(parseStoredVoiceSessionRecord(storedRecord(["not-a-hash"]))).toBeUndefined();
    expect(parseStoredVoiceSessionRecord(storedRecord([key, key]))).toBeUndefined();
    expect(
      parseStoredVoiceSessionRecord(
        storedRecord(
          Array.from({ length: VOICE_TRANSCRIPT_MAX_UNRESOLVED + 1 }, (_, index) =>
            index.toString(16).padStart(64, "0"),
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it.each([
    { name: "version", patch: { version: 2 } },
    { name: "origin", patch: { origin: "server" } },
    { name: "provider", patch: { provider: "   " } },
    { name: "updated timestamp", patch: { updatedAt: "later" } },
  ])("rejects an invalid $name", ({ patch }) => {
    const value = JSON.parse(storedRecord([])) as Record<string, unknown>;
    expect(parseStoredVoiceSessionRecord(JSON.stringify({ ...value, ...patch }))).toBeUndefined();
  });
});
