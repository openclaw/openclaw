import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createTranscriptEventInserter } from "../config/sessions/transcript-payload.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key retention repair", () => {
  it("copies only a cross-store winner and archives its stale same-store duplicate", async () => {
    await withStateDirEnv("openclaw-doctor-canonical-cross-store-", async ({ stateDir }) => {
      const { scope, insert, load, transcript, database, repair } = createCanonicalRepairFixture(
        stateDir,
        "shared",
        ["main", "ops"],
      );

      replaceSessionEntrySync(
        { ...scope(), sessionKey: "agent:main:shared" },
        {
          previousSessionId: "destination-only-previous",
          sessionId: "retained-destination",
          updatedAt: 5,
        },
      );
      const destinationDatabase = database();
      destinationDatabase.db
        .prepare(
          "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES ('destination-only-previous', 'agent:main:shared', 'recovery', 'conversation', 4, 4)",
        )
        .run();
      createTranscriptEventInserter(
        destinationDatabase.db,
        "destination-only-previous",
      )({
        seq: 0,
        eventJson: JSON.stringify({
          id: "destination-only-message",
          message: { content: "destination-only history", role: "user" },
          parentId: null,
          type: "message",
        }),
        createdAt: 4,
      });

      insert(
        "agent:main:shared ",
        { previousSessionId: "destination-only-previous", sessionId: "winner", updatedAt: 20 },
        "winner history",
        "ops",
      );
      const sourceDatabase = database("ops");
      for (const [label, sourceSessionKey] of [
        ["winner", "agent:main:shared "],
        ["loser", "agent:main:shared"],
      ] as const) {
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES (?, 'webchat', 'default', 'direct', ?, ?, '{}', 10, 10)",
          )
          .run(`${label}-conversation`, label, label);
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES (?, 'turn', ?, ?, ?, 'sent', 10, 10)",
          )
          .run(`${label}-operation`, `${label}-conversation`, sourceSessionKey, `${label}-hash`);
      }
      insert("agent:main:shared", { sessionId: "loser", updatedAt: 10 }, "loser history", "ops");

      const report = await repair();

      expect(report).toMatchObject({
        foundGroups: 1,
        removedRows: 2,
        repairedGroups: 1,
        scannedStores: 2,
      });
      expect(load("agent:main:shared", "main")?.entry.sessionId).toBe("winner");
      expect(load("agent:main:shared ", "ops")).toBeUndefined();
      expect(load("agent:main:shared", "ops")).toBeUndefined();
      await transcript("agent:main:shared", "winner", "winner history");
      await transcript("agent:main:shared", "loser");
      await transcript(
        "agent:main:shared",
        "destination-only-previous",
        "destination-only history",
      );
      expect(
        destinationDatabase.db
          .prepare(
            "SELECT operation_id, source_session_key FROM conversation_deliveries ORDER BY operation_id",
          )
          .all(),
      ).toEqual([{ operation_id: "winner-operation", source_session_key: "agent:main:shared" }]);
      expect(
        destinationDatabase.db
          .prepare(
            "SELECT previous_session_id, session_entry_provenance FROM session_windows WHERE session_id = 'winner'",
          )
          .get(),
      ).toEqual({ previous_session_id: "destination-only-previous", session_entry_provenance: 1 });
      expect(
        sourceDatabase.db
          .prepare("SELECT operation_id FROM conversation_deliveries ORDER BY operation_id")
          .all(),
      ).toEqual([]);
      const loserArchive = report.archivedTranscriptDirectories
        .flatMap((directory) =>
          fs
            .readdirSync(directory)
            .filter((name) => name.startsWith("loser.jsonl.deleted."))
            .map((name) => path.join(directory, name)),
        )
        .at(0);
      expect(loserArchive).toBeDefined();
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
        const sourceDatabase = database("ops");
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversations (conversation_id, channel, account_id, kind, peer_id, delivery_target, metadata_json, created_at, updated_at) VALUES ('winner-conversation', 'webchat', 'default', 'direct', 'winner', 'winner', '{}', 10, 10)",
          )
          .run();
        const progressJson = JSON.stringify({ lines: ["Retained progress"], label: "Working" });
        for (const [operationId, sourceSessionKey] of [
          ["winner-operation", "agent:main:work"],
          ["unrelated-operation", "agent:ops:other"],
        ] as const) {
          sourceDatabase.db
            .prepare(
              "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, platform_message_id, created_at, updated_at) VALUES (?, 'send', 'winner-conversation', ?, 'progress-hash', 'sent', 'progress-message', 10, 10)",
            )
            .run(operationId, sourceSessionKey);
          sourceDatabase.db
            .prepare(
              "INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES ('conversation-progress', ?, ?, 10)",
            )
            .run(operationId, progressJson);
        }
        sourceDatabase.db
          .prepare(
            "INSERT INTO conversation_deliveries (operation_id, operation_kind, conversation_id, source_session_key, message_hash, status, created_at, updated_at) VALUES ('canonical-operation', 'turn', 'winner-conversation', 'agent:main:work', 'canonical-hash', 'sent', 10, 10)",
          )
          .run();

        await expectRepair({ foundGroups: 1, repairedGroups: 1 });
        const destinationDatabase = database();
        expect(
          destinationDatabase.db
            .prepare(
              "SELECT operation_id, source_session_key FROM conversation_deliveries ORDER BY operation_id",
            )
            .all(),
        ).toEqual([
          { operation_id: "canonical-operation", source_session_key: "agent:main:work" },
          { operation_id: "winner-operation", source_session_key: "agent:main:work" },
        ]);
        expect(
          sourceDatabase.db
            .prepare("SELECT operation_id FROM conversation_deliveries ORDER BY operation_id")
            .all(),
        ).toEqual([{ operation_id: "unrelated-operation" }]);
        expect(
          destinationDatabase.db
            .prepare(
              "SELECT key, value_json FROM cache_entries WHERE scope = 'conversation-progress'",
            )
            .all(),
        ).toEqual([{ key: "winner-operation", value_json: progressJson }]);
        expect(
          sourceDatabase.db
            .prepare(
              "SELECT key, value_json FROM cache_entries WHERE scope = 'conversation-progress'",
            )
            .all(),
        ).toEqual([{ key: "unrelated-operation", value_json: progressJson }]);
      },
    );
  });
});
