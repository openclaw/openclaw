import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
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
  await expect(
    createSessionEntryWithTranscript(freshScope(), () => ({ ok: true, entry: freshEntry })),
  ).resolves.toEqual({ ok: true, entry: freshEntry, sessionFile: freshScope().sessionKey });

  expect(loadSessionEntry(freshScope())).toMatchObject(freshEntry);
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

it("retries unrelated exports after alias adoption commits and preserves recoverable errors", async () => {
  const scope = {
    sessionId: "adopted-session",
    sessionKey: "agent:main:signal:group:adopted",
    storePath: fixture.storePath(),
  };
  const entry = {
    sessionId: scope.sessionId,
    updatedAt: freshEntry.updatedAt,
    archivedAt: freshEntry.updatedAt - 1,
    archivedBy: { type: "human" as const, id: "archiver" },
    archiveReason: "manual" as const,
  };
  await replaceSessionEntry(scope, entry);
  const collisionPath = await failUnrelatedArchiveExport();
  const pendingArchive = readArchive();
  const adoptedEntry = { ...entry, label: "adopted" };
  const target = {
    ...scope,
    sessionKey: "agent:main:signal:group:Adopted",
  };
  const order: string[] = [];
  const adopt = () =>
    withoutHostSql(() =>
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
      ),
    );
  const committedOrder = ["committed", "registered"];
  const stop = onInternalSessionTranscriptUpdate((update) => {
    if (update.sessionFile === collisionPath) {
      order.push("archive-published");
    }
  });
  using _ = { [Symbol.dispose]: stop };
  for (const attempt of [1, 2]) {
    const recovered = attempt === 2;
    if (recovered) {
      fs.rmSync(collisionPath);
    }
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
    expect(order).toEqual(
      recovered ? [...committedOrder, ...committedOrder, "archive-published"] : committedOrder,
    );
    if (recovered) {
      expect(fs.readFileSync(collisionPath)).toEqual(Buffer.from(pendingArchive.archive_blob));
      expect(readSessionArchiveContentSync(collisionPath)).toBe(
        `${JSON.stringify(archivedEvent)}\n`,
      );
    } else {
      expect(fs.readFileSync(collisionPath, "utf8")).toBe("collision");
    }
    expect(loadSessionEntry(target)).toMatchObject(adoptedEntry);
  }
});
