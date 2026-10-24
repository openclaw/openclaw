import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
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
import { withoutHostSql } from "./session-accessor.observation.test-support.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { readTranscriptStorageRows } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { useTempSessionsFixture } from "./test-helpers.js";

const fixture = useTempSessionsFixture("openclaw-fresh-upsert-archive-");
const archivedSessionId = "unrelated-archived-session";
const archivedSessionKey = "agent:main:unrelated-archive";
const archivedEvent = { type: "session", id: archivedSessionId, content: "retain exact bytes" };
const freshEntry = { sessionId: "fresh-session", updatedAt: 1_800_000_000_000 };
const freshScope = () => ({
  sessionKey: "agent:main:fresh-session",
  storePath: fixture.storePath(),
});

it("skips empty archive recovery during warning-mode upserts", async () => {
  await replaceSessionEntry(freshScope(), freshEntry);
  const probe = vi.spyOn(archiveWorker, "readPendingSqliteTranscriptArchivesInWorker");
  using _ = { [Symbol.dispose]: () => probe.mockRestore() };
  for (let turn = 0; turn < 3; turn += 1) {
    await applySessionEntryLifecycleMutation({
      storePath: fixture.storePath(),
      skipMaintenance: false,
      maintenanceOverride: { mode: "warn" },
      upserts: [
        { sessionKey: freshScope().sessionKey, entry: { ...freshEntry, label: `turn-${turn}` } },
      ],
    });
  }
  expect(loadSessionEntry(freshScope())?.label).toBe("turn-2");
  expect(probe).not.toHaveBeenCalled();
});

function readArchive() {
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(freshScope())));
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_transcript_archives")
      .selectAll()
      .where("session_id", "=", archivedSessionId),
  );
  return expectDefined(row, "expected the unrelated canonical archive");
}

const removeArchived = (onLifecycleCommitted?: () => void) =>
  applySessionEntryLifecycleMutation({
    storePath: fixture.storePath(),
    removals: [{ sessionKey: archivedSessionKey, archiveRemovedTranscript: true }],
    skipMaintenance: true,
    onLifecycleCommitted,
  });

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
    removeArchived(() => {
      fs.writeFileSync(path.join(fixture.sessionsDir(), readArchive().archive_name), "collision");
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

  await expect(
    createSessionEntryWithTranscript(freshScope(), () => ({ ok: true, entry: freshEntry }), {
      resolveOwnerAssignment: () => owner,
    }),
  ).resolves.toEqual({ ok: true, entry: freshEntry, sessionFile: freshScope().sessionKey });

  expect(loadSessionEntry(freshScope())).toMatchObject({ ...freshEntry, owner });
  await expect(
    loadTranscriptEvents({ ...freshScope(), sessionId: freshEntry.sessionId }),
  ).resolves.toContainEqual(expect.objectContaining({ type: "session", id: freshEntry.sessionId }));
  expect(readArchive()).toEqual(pendingArchive);
  expect(fs.readFileSync(collisionPath, "utf8")).toBe("collision");

  fs.rmSync(collisionPath);
  await expect(removeArchived()).resolves.toMatchObject({ removedEntries: 0 });
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
    const committedOrder = ["committed", "registered"];
    for (const attempt of [1, 2]) {
      const recovered = attempt === 2;
      if (recovered) {
        fs.rmSync(collisionPath);
      }
      const stop = onInternalSessionTranscriptUpdate((update) => {
        if (update.sessionFile === collisionPath) {
          order.push("archive-published");
        }
      });
      try {
        await withoutHostSql(async () => {
          if (recovered) {
            await expect(adopt()).resolves.toMatchObject({
              ok: true,
              entry: adoptedEntry,
              sessionFile: target.sessionKey,
            });
          } else {
            await expect(adopt()).rejects.toThrow(
              "transcript archive file export(s) remain pending in SQLite",
            );
          }
        });
      } finally {
        stop();
      }
      expect(order).toEqual(
        recovered ? [...committedOrder, ...committedOrder, "archive-published"] : committedOrder,
      );
      expect(readArchive()).toEqual({
        ...pendingArchive,
        publish_attempts: pendingArchive.publish_attempts + attempt,
        last_publish_attempt_at: expect.any(Number),
        ...(recovered ? { last_publish_error: null, published_at: expect.any(Number) } : {}),
      });
      if (recovered) {
        expect(fs.readFileSync(collisionPath)).toEqual(Buffer.from(pendingArchive.archive_blob));
        expect(readSessionArchiveContentSync(collisionPath)).toBe(
          `${JSON.stringify(archivedEvent)}\n`,
        );
      } else {
        expect(fs.readFileSync(collisionPath, "utf8")).toBe("collision");
      }
      expect(loadSessionEntry(target)).toMatchObject(adoptedEntry);
      expect(readTranscriptStorageRows(database, scope.sessionId)).toEqual(retainedRows);
    }
  },
);
