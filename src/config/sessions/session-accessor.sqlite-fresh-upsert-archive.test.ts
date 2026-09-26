import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { onInternalSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  createSessionEntryWithTranscript,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { useTempSessionsFixture } from "./test-helpers.js";

describe("fresh session creation with pending transcript archives", () => {
  const fixture = useTempSessionsFixture("openclaw-fresh-upsert-archive-");
  const archivedSessionId = "unrelated-archived-session";
  const archivedSessionKey = "agent:main:unrelated-archive";
  const archivedEvent = { type: "session", id: archivedSessionId, content: "retain exact bytes" };
  const freshEntry = { sessionId: "fresh-session", updatedAt: 1_800_000_000_000 };
  const freshScope = () => ({
    sessionKey: "agent:main:fresh-session",
    storePath: fixture.storePath(),
  });

  function readArchive() {
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(freshScope())));
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_transcript_archives")
        .select([
          "archive_blob",
          "archive_name",
          "archive_sha256",
          "generation",
          "publish_attempts",
          "last_publish_attempt_at",
          "last_publish_error",
          "published_at",
        ])
        .where("session_id", "=", archivedSessionId),
    );
    if (!row) {
      throw new Error("expected the unrelated canonical archive");
    }
    return row;
  }

  async function failUnrelatedArchiveExport() {
    const scope = {
      sessionId: archivedSessionId,
      sessionKey: archivedSessionKey,
      storePath: fixture.storePath(),
    };
    await replaceSessionEntry(scope, {
      sessionId: archivedSessionId,
      updatedAt: freshEntry.updatedAt,
    });
    await replaceTranscriptEvents(scope, [archivedEvent]);
    await expect(
      applySessionEntryLifecycleMutation({
        storePath: scope.storePath,
        removals: [{ sessionKey: archivedSessionKey, archiveRemovedTranscript: true }],
        skipMaintenance: true,
        onLifecycleCommitted: () => {
          fs.writeFileSync(
            path.join(fixture.sessionsDir(), readArchive().archive_name),
            "collision",
          );
        },
      }),
    ).rejects.toThrow("transcript archive file export(s) remain pending in SQLite");
    expect(loadSessionEntry(scope)).toBeUndefined();
    expect(readArchive()).toMatchObject({
      published_at: null,
      last_publish_error: expect.stringContaining("collision"),
    });
    return path.join(fixture.sessionsDir(), readArchive().archive_name);
  }

  it("creates a fresh session without retrying an unrelated failed export, which deletion can still recover", async () => {
    const collisionPath = await failUnrelatedArchiveExport();
    const pendingArchive = readArchive();
    const owner = {
      actor: { type: "human" as const, id: "profile-owner" },
      assignedBy: { type: "agent" as const, id: "main" },
      assignedAt: 42,
    };

    const [creation] = await Promise.allSettled([
      createSessionEntryWithTranscript(freshScope(), () => ({ ok: true, entry: freshEntry }), {
        resolveOwnerAssignment: () => owner,
      }),
    ]);

    expect(loadSessionEntry(freshScope())).toMatchObject({ ...freshEntry, owner });
    await expect(
      loadTranscriptEvents({ ...freshScope(), sessionId: freshEntry.sessionId }),
    ).resolves.toContainEqual(
      expect.objectContaining({ type: "session", id: freshEntry.sessionId }),
    );
    expect(creation).toEqual({
      status: "fulfilled",
      value: { ok: true, entry: freshEntry, sessionFile: freshScope().sessionKey },
    });
    expect(readArchive()).toEqual(pendingArchive);
    expect(fs.readFileSync(collisionPath, "utf8")).toBe("collision");

    fs.rmSync(collisionPath);
    await expect(
      applySessionEntryLifecycleMutation({
        storePath: fixture.storePath(),
        removals: [{ sessionKey: archivedSessionKey, archiveRemovedTranscript: true }],
        skipMaintenance: true,
      }),
    ).resolves.toMatchObject({ removedEntries: 0 });
    expect(readArchive()).toMatchObject({
      archive_sha256: pendingArchive.archive_sha256,
      published_at: expect.any(Number),
      last_publish_error: null,
    });
    expect(readSessionArchiveContentSync(collisionPath)).toBe(`${JSON.stringify(archivedEvent)}\n`);
    expect(loadSessionEntry(freshScope())).toMatchObject(freshEntry);
  });

  it.each(["canonical", "alias"] as const)(
    "retries unrelated archive exports after %s adoption commits, retaining history and recoverable errors",
    async (kind) => {
      const scope = {
        sessionId: "adopted-session",
        sessionKey:
          kind === "alias" ? "agent:main:signal:group:adopted" : "agent:main:adopted-session",
        storePath: fixture.storePath(),
      };
      const entry = {
        sessionId: scope.sessionId,
        updatedAt: freshEntry.updatedAt,
        archivedAt: freshEntry.updatedAt - 1,
        archivedBy: { type: "human" as const, id: "archiver" },
        archiveReason: "manual" as const,
      };
      const transcript = [
        { type: "session", id: scope.sessionId, version: 3, cwd: "/workspace" },
        {
          type: "message",
          id: "retained-message",
          parentId: null,
          timestamp: "2026-07-15T21:23:03.698Z",
          message: { role: "user", content: "Keep adopted history.\r\n  Preserve spacing." },
        },
      ];
      await replaceSessionEntry(scope, entry);
      await replaceTranscriptEvents(scope, transcript);
      const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
      const retainedRows = readTranscriptStorageRows(database, scope.sessionId);
      expect(retainedRows).toHaveLength(transcript.length);
      const collisionPath = await failUnrelatedArchiveExport();
      const pendingArchive = readArchive();
      const adoptedEntry = { ...entry, label: "adopted" };
      const target = {
        ...scope,
        sessionKey: kind === "alias" ? "agent:main:signal:group:Adopted" : scope.sessionKey,
      };
      const order: string[] = [];
      const stop = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionFile === collisionPath) {
          order.push("archive-published");
        }
      });
      const adopt = () =>
        createSessionEntryWithTranscript(
          target,
          ({ existingEntry }) => {
            expect(existingEntry).toMatchObject(entry);
            return { ok: true, entry: { ...existingEntry!, label: adoptedEntry.label } };
          },
          {
            onLifecycleCommitted: () => {
              order.push("committed");
            },
            afterCommitted: async (_entry, source) => {
              source.assertCurrent();
              order.push("registered");
            },
          },
        );
      const sql = observeHostDataSql();
      try {
        await expect(adopt()).rejects.toThrow(
          "transcript archive file export(s) remain pending in SQLite",
        );
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
        stop();
      }
      expect(order).toEqual(["committed", "registered"]);
      expect(readArchive()).toEqual({
        ...pendingArchive,
        publish_attempts: pendingArchive.publish_attempts + 1,
        last_publish_attempt_at: expect.any(Number),
      });
      expect(fs.readFileSync(collisionPath, "utf8")).toBe("collision");
      expect(loadSessionEntry(target)).toMatchObject(adoptedEntry);
      expect(readTranscriptStorageRows(database, scope.sessionId)).toEqual(retainedRows);

      fs.rmSync(collisionPath);
      const stopRecovered = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionFile === collisionPath) {
          order.push("archive-published");
        }
      });
      const recoverySql = observeHostDataSql();
      try {
        await expect(adopt()).resolves.toMatchObject({
          ok: true,
          entry: adoptedEntry,
          sessionFile: target.sessionKey,
        });
        expect(recoverySql.queries).toEqual([]);
      } finally {
        recoverySql.restore();
        stopRecovered();
      }
      expect(order).toEqual([
        "committed",
        "registered",
        "committed",
        "registered",
        "archive-published",
      ]);
      expect(readArchive()).toEqual({
        ...pendingArchive,
        last_publish_attempt_at: expect.any(Number),
        last_publish_error: null,
        publish_attempts: pendingArchive.publish_attempts + 2,
        published_at: expect.any(Number),
      });
      expect(fs.readFileSync(collisionPath)).toEqual(Buffer.from(pendingArchive.archive_blob));
      expect(readSessionArchiveContentSync(collisionPath)).toBe(
        `${JSON.stringify(archivedEvent)}\n`,
      );
      expect(loadSessionEntry(target)).toMatchObject(adoptedEntry);
      expect(readTranscriptStorageRows(database, scope.sessionId)).toEqual(retainedRows);
    },
  );

  it.each([
    "existing upsert",
    "canonical repair",
    "Doctor transfer",
    "maintenance",
    "empty retry",
  ] as const)(
    "recovers pending archives during %s without producing a new archive",
    async (operation) => {
      if (operation === "existing upsert") {
        await replaceSessionEntry(freshScope(), freshEntry);
      }
      const collisionPath = await failUnrelatedArchiveExport();
      fs.rmSync(collisionPath);

      await applySessionEntryLifecycleMutation({
        storePath: fixture.storePath(),
        skipMaintenance: operation !== "maintenance",
        ...(operation === "maintenance" ? { maintenanceOverride: { mode: "warn" as const } } : {}),
        ...(operation === "canonical repair" ? { allowCanonicalRepair: true } : {}),
        ...(operation === "Doctor transfer" ? { afterUpsertsInTransaction: () => {} } : {}),
        ...(operation === "empty retry"
          ? {}
          : { upserts: [{ sessionKey: freshScope().sessionKey, entry: freshEntry }] }),
      });

      expect(readArchive()).toMatchObject({
        published_at: expect.any(Number),
        last_publish_error: null,
      });
      expect(readSessionArchiveContentSync(collisionPath)).toBe(
        `${JSON.stringify(archivedEvent)}\n`,
      );
      if (operation !== "empty retry") {
        expect(loadSessionEntry(freshScope())).toMatchObject(freshEntry);
      }
    },
  );
});
