import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSessionArchiveText } from "../../test/helpers/session-archive.js";
import {
  ensureTranscriptGenerationsForCanonicalRepair,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createCanonicalRepairFixture } from "./doctor-session-repair-fixture.test-support.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

describe("doctor canonical session-key retention repair", () => {
  it.each(["current", "historical", "damaged"])(
    "restores foreign-agent %s cold history by its physical store owner before repair",
    async (variant) => {
      await withStateDirEnv("doctor-renamed-cold-", async ({ stateDir }) => {
        const { cfg, env, scope, insert, database, load, repair } = createCanonicalRepairFixture(
          stateDir,
          undefined,
          ["newname"],
        );
        const sessionKey = "agent:oldname:conversation";
        const entry = { sessionId: "renamed-cold-history", updatedAt: 1 };
        const source = { ...scope("newname"), sessionKey, entry };
        insert(sessionKey, entry, "Preserve renamed history 🦞", "newname");
        await withDoctorSqliteMaintenanceLock({
          env,
          operation: "session SQLite import",
          run: async () => {
            await ensureTranscriptGenerationsForCanonicalRepair([source]);
            sessionSqlFixture(database("newname").db)`UPDATE session_windows
            SET transcript_updated_at = 1 WHERE session_id = ${entry.sessionId}`.run();
            expect(
              await runSessionColdStorageMaintenance({
                config: {
                  ...cfg,
                  session: {
                    ...cfg.session,
                    maintenance: { coldStorage: { enabled: true, afterDays: 1 } },
                  },
                },
              }),
            ).toMatchObject({ archivedTranscripts: 1 });
          },
        });
        const cold = readSessionColdTranscript(database("newname").db, entry.sessionId);
        expect(cold?.storage).toBe("file");
        if (!cold) {
          throw new Error("Expected a cold archive");
        }
        const archivePath = resolveSessionColdArchivePath(source.storePath, cold.archive_name);
        const archiveBytes = fs.readFileSync(archivePath);
        const selectedEntry =
          variant === "historical" ? { sessionId: "renamed-current", updatedAt: 2 } : entry;
        if (variant === "historical") {
          // Retain a historical window no longer mentioned by the current entry.
          sessionSqlFixture(database("newname").db)`UPDATE session_nodes
          SET current_session_id = ${selectedEntry.sessionId}, entry_json = ${JSON.stringify(selectedEntry)}
          WHERE session_key = ${sessionKey}`.run();
        }
        expect(await repair(false)).toMatchObject({ foundGroups: 1, repairedGroups: 0 });
        expect(readSessionColdTranscript(database("newname").db, entry.sessionId)).toEqual(cold);

        if (variant === "damaged") {
          const damaged = Buffer.from(archiveBytes);
          damaged[0] = damaged[0]! ^ 1;
          fs.writeFileSync(archivePath, damaged);
          await expect(repair()).rejects.toThrow("failed verification");
          expect(load(sessionKey, "newname")?.entry.sessionId).toBe(entry.sessionId);
          expect(readSessionColdTranscript(database("newname").db, entry.sessionId)).toEqual(cold);
          expect(fs.readFileSync(archivePath)).toEqual(damaged);
          fs.writeFileSync(archivePath, archiveBytes);
        }
        expect(await repair()).toMatchObject({ foundGroups: 1, repairedGroups: 1 });
        expect(load(sessionKey, "newname")).toBeUndefined();
        expect(load(sessionKey, "oldname")?.entry.sessionId).toBe(selectedEntry.sessionId);
        const restored = await loadTranscriptEvents({
          ...scope("oldname"),
          sessionKey,
          sessionId: entry.sessionId,
        });
        expect(restored).toEqual([
          {
            id: "renamed-cold-history-message",
            message: { role: "user", content: "Preserve renamed history 🦞" },
            parentId: null,
            type: "message",
          },
        ]);
        expect(await repair()).toMatchObject({ foundGroups: 0, repairedGroups: 0 });
      });
    },
  );

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
      expect(readSessionArchiveText(loserArchive as string)).toContain("loser history");
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
