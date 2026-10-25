import { describe, expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readOpenVoiceSessions } from "../../talk/client-voice-session-lookup.worker.js";
import {
  writeVoiceSessionRecordInTransaction,
  type ClientVoiceSessionRecord,
} from "../../talk/client-voice-session-store.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(`${engine} voice lookup`, () => {
    useMixedAgentPair(engine, engine);

    it("finds open legacy and stale sessions while excluding malformed, closed and unrelated records", () =>
      withEngineStoreAdmission(() => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const options = { agentId: "main", path: database.path };
        const record: ClientVoiceSessionRecord = {
          version: 1,
          voiceSessionId: "first",
          agentId: "main",
          sessionKey: "agent:main:voice-portability",
          origin: "client",
          status: "open",
          createdAt: 10,
          updatedAt: 20,
          consultRunIds: [],
          effects: [],
          transcriptFailureKeys: [],
        };
        runSqliteImmediateTransactionSync(database.db, () => {
          for (const change of [
            {},
            { voiceSessionId: "second", updatedAt: 30 },
            { voiceSessionId: "closed", status: "closed" as const },
            { voiceSessionId: "relay", origin: "relay" as const, updatedAt: 40 },
            { voiceSessionId: "other", sessionKey: "agent:main:other", updatedAt: 50 },
          ]) {
            writeVoiceSessionRecordInTransaction(database, { ...record, ...change });
          }
          database.db
            .prepare(
              "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('talk-client-voice-sessions', 'malformed', ?, 1)",
            )
            .run("{invalid");
        });
        const legacy = readOpenVoiceSessions(options, {
          kind: "legacy",
          agentId: "main",
          sessionKey: record.sessionKey,
        });
        expect(legacy.kind).toBe("voice-sessions");
        expect(
          legacy.matches.toSorted((left, right) =>
            left.voiceSessionId.localeCompare(right.voiceSessionId),
          ),
        ).toEqual([
          { voiceSessionId: "first", sessionKey: record.sessionKey },
          { voiceSessionId: "second", sessionKey: record.sessionKey },
        ]);
        expect(
          readOpenVoiceSessions(options, {
            kind: "stale",
            agentId: "main",
            updatedBefore: 30,
            excludeVoiceSessionId: "second",
          }).matches,
        ).toEqual([{ voiceSessionId: "first", sessionKey: record.sessionKey }]);
      }));
  });
}
