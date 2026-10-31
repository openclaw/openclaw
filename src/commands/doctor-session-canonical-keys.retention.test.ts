import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key retention repair", () => {
  it("copies only a cross-store winner and archives its stale same-store duplicate", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-cross-store-", async ({ stateDir }) => {
      const { scope, insert, load, transcript, database, repair } = createCanonicalRepairFixture(
        stateDir,
        "shared",
        ["main", "ops"],
      );
      const key = "agent:main:shared";
      const previousId = "destination-only-previous";

      insert(key, { sessionId: previousId, updatedAt: 4 }, "destination-only history");
      replaceSessionEntrySync(
        { ...scope(), sessionKey: key },
        { previousSessionId: previousId, sessionId: "retained-destination", updatedAt: 5 },
      );
      const destination = sessionSqlFixture(database().db);
      destination`UPDATE session_windows SET reason = 'recovery'
        WHERE session_id = ${previousId}`.run();

      insert(
        `${key} `,
        { previousSessionId: previousId, sessionId: "winner", updatedAt: 20 },
        "winner history",
        "ops",
      );
      const source = sessionSqlFixture(database("ops").db);
      for (const [label, sourceSessionKey] of [
        ["winner", `${key} `],
        ["loser", key],
      ] as const) {
        source`INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at)
          VALUES (${label + "-conversation"}, 'webchat', 'default', 'direct', ${label}, ${label}, '{}', 10, 10)`.run();
        source`INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at)
          VALUES (${label + "-operation"}, 'turn', ${label + "-conversation"}, ${sourceSessionKey}, ${label + "-hash"}, 'sent', 10, 10)`.run();
      }
      insert(key, { sessionId: "loser", updatedAt: 10 }, "loser history", "ops");

      const report = await repair();

      expect(load(key, "main")?.entry.sessionId).toBe("winner");
      expect(load(`${key} `, "ops")).toBeUndefined();
      expect(load(key, "ops")).toBeUndefined();
      await transcript(key, "winner", "winner history");
      await transcript(key, "loser");
      await transcript(key, previousId, "destination-only history");
      expect(
        destination`SELECT operation_id, source_session_key FROM conversation_deliveries ORDER BY operation_id`.all(),
      ).toEqual([{ operation_id: "winner-operation", source_session_key: key }]);
      expect(
        destination`SELECT previous_session_id, session_entry_provenance FROM session_windows WHERE session_id = 'winner'`.get(),
      ).toEqual({ previous_session_id: previousId, session_entry_provenance: 1 });
      expect(
        source`SELECT operation_id FROM conversation_deliveries ORDER BY operation_id`.all(),
      ).toEqual([]);
      const loserArchive = report.archivedTranscriptDirectories
        .flatMap((directory) =>
          fs
            .readdirSync(directory)
            .filter((name) => name.startsWith("loser.jsonl.deleted."))
            .map((name) => path.join(directory, name)),
        )
        .at(0);
      expect(readSessionArchiveContentSync(loserArchive as string)).toContain("loser history");
    });
  });

  it("copies a lone cross-store winner's normalized delivery key and retained progress", async () => {
    await withStateDirEnv(
      "openclaw-doctor-canonical-cross-store-delivery-",
      async ({ stateDir }) => {
        const { insert, database, expectRepair } = createCanonicalRepairFixture(stateDir, "work", [
          "main",
          "ops",
        ]);
        insert("agent:main:work ", { sessionId: "winner", updatedAt: 20 }, undefined, "ops");
        const source = sessionSqlFixture(database("ops").db);
        source`INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at)
          VALUES ('winner-conversation', 'webchat', 'default', 'direct', 'winner', 'winner', '{}', 10, 10)`.run();
        const progressJson = JSON.stringify({ lines: ["Retained progress"], label: "Working" });
        for (const [operationId, sourceSessionKey] of [
          ["winner-operation", "agent:main:work"],
          ["unrelated-operation", "agent:ops:other"],
        ] as const) {
          source`INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, platform_message_id, created_at, updated_at)
            VALUES (${operationId}, 'send', 'winner-conversation', ${sourceSessionKey}, 'progress-hash', 'sent', 'progress-message', 10, 10)`.run();
          source`INSERT INTO cache_entries (scope, key, value_json, updated_at)
            VALUES ('conversation-progress', ${operationId}, ${progressJson}, 10)`.run();
        }
        source`INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at)
          VALUES ('canonical-operation', 'turn', 'winner-conversation', 'agent:main:work', 'canonical-hash', 'sent', 10, 10)`.run();

        await expectRepair({ foundGroups: 1, repairedGroups: 1 });
        const destination = sessionSqlFixture(database().db);
        expect(
          destination`SELECT operation_id, source_session_key FROM conversation_deliveries ORDER BY operation_id`.all(),
        ).toEqual([
          { operation_id: "canonical-operation", source_session_key: "agent:main:work" },
          { operation_id: "winner-operation", source_session_key: "agent:main:work" },
        ]);
        expect(
          source`SELECT operation_id FROM conversation_deliveries ORDER BY operation_id`.all(),
        ).toEqual([{ operation_id: "unrelated-operation" }]);
        expect(
          destination`SELECT key, value_json FROM cache_entries WHERE scope = 'conversation-progress'`.all(),
        ).toEqual([{ key: "winner-operation", value_json: progressJson }]);
        expect(
          source`SELECT key, value_json FROM cache_entries WHERE scope = 'conversation-progress'`.all(),
        ).toEqual([{ key: "unrelated-operation", value_json: progressJson }]);
      },
    );
  });
});
