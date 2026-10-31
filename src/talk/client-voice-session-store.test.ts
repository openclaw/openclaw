import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  type OpenClawAgentDatabase,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { readOpenVoiceSessions } from "./client-voice-session-lookup.worker.js";
import {
  parseStoredVoiceSessionRecord,
  type ClientVoiceSessionRecord,
  type VoiceSessionLookup,
  readVoiceSessionRecordInTransaction,
  writeVoiceSessionRecordInTransaction,
} from "./client-voice-session-store.js";
import { VOICE_TRANSCRIPT_MAX_UNRESOLVED } from "./voice-transcript.js";

const options = { agentId: "main" };
const scope = "talk-client-voice-sessions";
const binding = { agentId: "main", voiceSessionId: "voice-1", sessionKey: "agent:main:main" };
const original: ClientVoiceSessionRecord = {
  ...binding,
  version: 1,
  origin: "client",
  status: "open",
  createdAt: 1,
  updatedAt: 1,
  consultRunIds: [],
  effects: [],
  transcriptFailureKeys: [],
};
const parseRecord = (transcriptFailureKeys: unknown, patch?: Record<string, unknown>) =>
  parseStoredVoiceSessionRecord(JSON.stringify({ ...original, transcriptFailureKeys, ...patch }));
const lookup = (input: VoiceSessionLookup) => readOpenVoiceSessions(options, input).matches;
const write = (patch: Partial<ClientVoiceSessionRecord>) =>
  runOpenClawAgentWriteTransaction(
    (owner) => writeVoiceSessionRecordInTransaction(owner, { ...original, ...patch }),
    options,
  );

describe("client voice session store persisted records", () => {
  let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
  let database: OpenClawAgentDatabase;
  beforeEach(async () => {
    home = await createTempHomeEnv("openclaw-voice-store-");
    database = openOpenClawAgentDatabase(options);
  });
  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await home.restore();
  });

  it("preserves cache custody columns across rejected updates and a successful retry", async () => {
    write({ updatedAt: 1 });
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
    expect(() => write({ updatedAt: 2 })).toThrow("synthetic voice update failure");
    expect(database.db.isTransaction).toBe(false);
    expect(read()).toEqual(before);
    database.db.exec("DROP TRIGGER reject_voice_update");
    write({ updatedAt: 3 });
    expect(read()).toEqual({
      value_json: JSON.stringify({ ...original, updatedAt: 3 }),
      blob: "00FF04",
      expires_at: 123,
    });
    const saved = readVoiceSessionRecordInTransaction(database, original.voiceSessionId);
    expect(saved).toEqual({ ...original, updatedAt: 3 });
  });

  it("filters open lookup candidates in SQL before decoding payloads", async () => {
    const rows = [];
    for (const patch of [
      { voiceSessionId: "selected" },
      { voiceSessionId: "closed", status: "closed" },
      { voiceSessionId: "other", sessionKey: "agent:main:other" },
      { voiceSessionId: "relay", origin: "relay" },
      { voiceSessionId: "foreign", agentId: "other" },
      { voiceSessionId: "recent", sessionKey: "agent:main:recent", updatedAt: 10 },
      { voiceSessionId: "excluded", sessionKey: "agent:main:excluded" },
      { voiceSessionId: "invalid", version: 2 },
    ]) {
      rows.push({ ...original, ...patch });
    }
    const insert = database.db.prepare(
      "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(scope, row.voiceSessionId, JSON.stringify(row), row.updatedAt);
    }
    insert.run(scope, "malformed", "{broken", 1);
    insert.run("unrelated-cache", "other", "not JSON", 1);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const legacy = lookup({ kind: "legacy", ...options, sessionKey: binding.sessionKey });
      expect(legacy).toEqual([{ voiceSessionId: "selected", sessionKey: binding.sessionKey }]);
      const decoded = () =>
        parse.mock.calls
          .map(([value]) => value)
          .filter((value) => value.includes('"voiceSessionId"'));
      const expected = [rows[0], rows[7]].map((row) => JSON.stringify(row));
      expect(decoded().toSorted()).toEqual(expected.toSorted());
      parse.mockClear();
      const stale = lookup({
        kind: "stale",
        ...options,
        updatedBefore: 1,
        excludeVoiceSessionId: "excluded",
      }).map((row) => row.voiceSessionId);
      expect(stale.toSorted()).toEqual(["foreign", "other", "relay", "selected"]);
      expect(decoded()).toHaveLength(5);
      for (const row of [rows[1], rows[5], rows[6]]) {
        expect(decoded()).not.toContain(JSON.stringify(row));
      }
    } finally {
      parse.mockRestore();
    }
  });
});

it("defaults unresolved transcript failures for existing records", () => {
  expect(parseRecord(undefined)?.transcriptFailureKeys).toEqual([]);
});

it("rejects malformed, duplicate, or over-cap unresolved transcript failures", () => {
  const key = "a".repeat(64);
  expect(parseRecord(["not-a-hash"])).toBeUndefined();
  expect(parseRecord([key, key])).toBeUndefined();
  const tooMany = Array.from({ length: VOICE_TRANSCRIPT_MAX_UNRESOLVED + 1 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  expect(parseRecord(tooMany)).toBeUndefined();
});

it("rejects an invalid provider", () => {
  expect(parseRecord([], { provider: "   " })).toBeUndefined();
});
