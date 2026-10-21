import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { readOpenClawAgentDatabaseIdentity as databaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  runOpenClawAgentWriteTransaction as writeTransaction,
} from "../../state/openclaw-agent-db.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  databasePath,
  type ClaimTarget,
  outcomeKinds,
  readClaim,
  recordHarnessDeletions,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { readSessionTranscriptHistoryAnchorPage as readHistoryPage } from "./session-accessor.sqlite-history.test-support.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { rotateTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction as appendEvent } from "./session-accessor.sqlite-transcript-store.js";
import { readVerifiedSessionColdArchive } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";

const { createFixture } = setupLegacyMainSessionMigrationTests();
type Fixture = ReturnType<typeof createFixture>;

function repair({ cfg, env }: Fixture, mode: "doctor-fix" | "detect" = "doctor-fix") {
  return migrateLegacyMainSessionKeys({ cfg, env, mode });
}

function claim(
  fixture: Fixture,
  agentId: string,
  key = `agent:${agentId}:chat`,
  pathname = databasePath(fixture.stateDir, agentId),
): ClaimTarget {
  return { databaseAgentId: agentId, databasePath: pathname, key };
}

function transaction<T>(
  target: ClaimTarget,
  run: Parameters<typeof writeTransaction<T>>[0],
  env?: NodeJS.ProcessEnv,
) {
  const { databaseAgentId: agentId, databasePath: pathname } = target;
  return writeTransaction(run, { agentId, path: pathname, env });
}

function message(id: string, role: string, content: string, parent?: string, key?: string) {
  const body = { role, content, ...(key ? { idempotencyKey: key } : {}) };
  return { type: "message", id, parentId: parent ?? null, message: body };
}

function archiveCold(store: string) {
  const session = { store, maintenance: { coldStorage: { enabled: true, afterDays: 30 } } };
  const config = { agents: { entries: { main: {} } }, session };
  return runSessionColdStorageMaintenance({ config });
}

function historyScope(fixture: Fixture, target: ClaimTarget, sessionId: string) {
  const { databaseAgentId: agentId, databasePath: storePath, key: sessionKey } = target;
  return { agentId, storePath, sessionKey, sessionId, env: fixture.env };
}

function updateWindow(target: ClaimTarget, assignments: string, env: NodeJS.ProcessEnv) {
  const sql = `UPDATE session_windows SET ${assignments} WHERE session_key = ?`;
  transaction(target, ({ db }) => db.prepare(sql).run(target.key), env);
}

it("refuses cleanup rebound to an identical destination database", async () => {
  const fixture = createFixture();
  const entry = { sessionId: "rebound-source", updatedAt: 100 };
  const source = claim(fixture, "main", "agent:ops:chat");
  const destination = claim(fixture, "ops", source.key);
  seedClaim({ ...source, entry });
  seedClaim({ ...destination, entry });
  const before = [readClaim(source), readClaim(destination)];
  expect(before[0]?.entry).toEqual(before[1]?.entry);
  const identity = transaction(source, (database) => databaseIdentity(database).identity);
  const deletion = {
    archiveTranscript: false,
    deleteTranscriptWithoutArchive: true,
    expectedEntry: before[0]!.entry,
    expectedDatabaseIdentity: identity,
    target: { canonicalKey: source.key, storeKeys: [source.key] },
  };
  const remove = ({ databaseAgentId: agentId, databasePath: storePath }: ClaimTarget) =>
    deleteSessionEntryLifecycle({ ...deletion, agentId, storePath });
  const refused = { deleted: false, expectedEntryMismatch: true };
  await expect(remove(destination)).resolves.toMatchObject(refused);
  expect([readClaim(source), readClaim(destination)]).toEqual(before);
  await expect(remove(source)).resolves.toMatchObject({ deleted: true });
  expect(readClaim(destination)).toEqual(before[1]);
});

it.each(["foreign partition", "new destination"])("hands off %s", async (kind) => {
  const fixture = createFixture();
  const foreign = kind === "foreign partition";
  const storePath = path.join(fixture.stateDir, "shared.json");
  fixture.cfg.session = { store: storePath };
  if (foreign) {
    fixture.cfg.agents = {
      defaults: { sessionStore: { agentId: "ops" } },
      entries: { ops: {}, beta: {} },
    };
  }
  const destinationPath = path.join(fixture.stateDir, "shared.sqlite");
  const foreignPath = path.join(fixture.stateDir, "shared.beta.sqlite");
  const source = foreign
    ? claim(fixture, "beta", "agent:main:chat", foreignPath)
    : claim(fixture, "main");
  const destination = claim(fixture, "ops", "agent:ops:chat", destinationPath);
  const sibling = foreign
    ? { ...destination, key: "agent:ops:keep" }
    : { ...source, key: "agent:other:keep" };
  const entry = seedClaim({ ...source, events: [{ kind: "repeat" }, { kind: "repeat" }] });
  seedClaim(sibling);
  const sourceBefore = readClaim(source);
  const siblingBefore = readClaim(sibling);
  if (foreign) {
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: [source.key, entry.sessionId],
      assertAllowed: () => {},
    });
    try {
      await expect(repair(fixture)).rejects.toThrow("competing work is in flight");
      expect(readClaim(source)).toEqual(sourceBefore);
    } finally {
      admission.release();
    }
  }
  const result = await repair(fixture);
  const retry = await repair(fixture);
  expect(result.complete).toBe(true);
  expect(retry.ledgerComplete).toBe(true);
  expect(readClaim(source)).toBeUndefined();
  expect(readClaim(destination)?.entry).toMatchObject(entry);
  expect(readClaim(destination)?.events).toEqual(sourceBefore?.events);
  expect(readClaim(sibling)).toEqual(siblingBefore);
  const unusedPartition = foreign ? "main" : "ops";
  const unusedPath = path.join(fixture.stateDir, `shared.${unusedPartition}.sqlite`);
  expect(fs.existsSync(unusedPath)).toBe(false);
  if (!foreign) {
    expect(outcomeKinds(result)).toContain("migrated-cross-store");
    expect(fs.existsSync(storePath)).toBe(false);
    const events = transaction(source, (db) => readTranscriptEventRows(db, entry.sessionId));
    expect(events).toEqual([]);
  }
});

it("preserves anchored history and recorded idempotency ownership across stores", async () => {
  const fixture = createFixture();
  const sourceTarget = claim(fixture, "main");
  const destination = claim(fixture, "ops");
  const sessionId = "identity-transfer";
  const { databasePath: pathname, key: sessionKey } = sourceTarget;
  const source = { agentId: "main", path: pathname, sessionId, sessionKey };
  seedClaim({
    ...sourceTarget,
    entry: { sessionId, updatedAt: 100 },
    events: [
      { type: "session", version: 3, id: sessionId },
      message("question", "user", "Preserve this migrated question."),
      message("earlier-answer", "assistant", "Earlier answer.", "question", "answer-key"),
    ],
  });
  const expectedIdentities = transaction(sourceTarget, (database) => {
    appendEvent(
      database,
      source,
      message("latest-answer", "assistant", "Latest answer.", "earlier-answer", "answer-key"),
      { allowStoredAlias: true, idempotencyKeyMode: "relocate-owner" },
    );
    return database.db
      .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
      .all(sessionId);
  });
  const before = readClaim(sourceTarget);
  const owners = { "earlier-answer": null, "latest-answer": "answer-key" };
  for (const [event_id, message_idempotency_key] of Object.entries(owners)) {
    expect(expectedIdentities).toContainEqual(
      expect.objectContaining({ event_id, message_idempotency_key }),
    );
  }

  expect(await repair(fixture)).toMatchObject({ complete: true });
  expect(
    readHistoryPage(historyScope(fixture, destination, sessionId), {
      messageId: "question",
      maxMessages: 3,
    }),
  ).toMatchObject({ found: true });
  expect(readClaim(destination)?.events).toEqual(before?.events);
  expect(
    transaction(destination, (database) =>
      database.db
        .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
        .all(sessionId),
    ),
  ).toEqual(expectedIdentities);
});

it.each([
  "before-copy",
  "during-delete",
  "destination-change",
  "destination-disposal",
  "destination-watermark-delete",
  "destination-watermark-replace",
  "destination-watermark-missing",
] as const)("preserves source claims when transfer authority changes (%s)", async (phase) => {
  const fixture = createFixture();
  const source = claim(fixture, "main");
  const destination = claim(fixture, "ops");
  const entry = { sessionId: "identity-conflict", updatedAt: 100 };
  const events = [
    message("answer", "assistant", "Unchanged answer bytes.", undefined, "recorded-owner"),
  ];
  seedClaim({ ...source, entry, events });
  const beforeCopy = phase === "before-copy" || phase === "destination-watermark-missing";
  if (beforeCopy) {
    seedClaim({ ...destination, entry, events });
  }
  const before = readClaim(source);
  let changed = false;
  const changeOwnership = () => {
    if (changed) {
      return;
    }
    changed = true;
    if (phase === "destination-disposal") {
      expect(closeOpenClawAgentDatabaseByPath(destination.databasePath)).toBe(true);
      return;
    }
    const target = phase.startsWith("destination-") ? destination : source;
    transaction(target, (database) => {
      if (phase === "destination-watermark-replace") {
        rotateTranscriptGenerationInTransaction(database, entry.sessionId);
        return;
      }
      const sql = phase.startsWith("destination-watermark-")
        ? "DELETE FROM transcript_rewrite_watermarks WHERE session_id = ?"
        : "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = 'answer'";
      database.db.prepare(sql).run(entry.sessionId);
    });
  };
  if (beforeCopy) {
    changeOwnership();
  }
  const { committed } = await recordHarnessDeletions(
    async () => {
      const migration = repair(fixture, beforeCopy ? "detect" : "doctor-fix");
      if (beforeCopy || phase === "during-delete") {
        expect((await migration).complete).toBe(false);
      } else {
        await expect(migration).rejects.toThrow(
          "Canonical session changed before legacy cleanup: agent:ops:chat",
        );
      }
    },
    beforeCopy ? undefined : changeOwnership,
  );
  expect(changed).toBe(true);
  expect(readClaim(source)).toEqual(before);
  expect(readClaim(destination)?.events).toEqual(before?.events);
  expect(committed).toEqual([]);
});

it.each(["existing-current", "cold", "utf16"] as const)(
  "preserves every retained generation through a %s cross-store handoff",
  async (kind) => {
    const fixture = createFixture();
    const canonicalKey = "agent:ops:chat";
    const source = claim(fixture, "main");
    const destination = claim(fixture, "ops");
    const destinationPath = destination.databasePath;
    const ids = ["retained-first", "retained-previous", "current"];
    const entries = ids.map((sessionId, index) => ({
      sessionId,
      updatedAt: index + 1,
      ...(index > 0 ? { previousSessionId: ids[index - 1] } : {}),
    }));
    const events = ids.map((id, index) => {
      const timestamp = new Date(index + 1).toISOString();
      return [
        { type: "session", version: 3, id, timestamp },
        {
          ...message(`message-${index}`, "user", `Retained exact history ${index}: café 🦞`),
          timestamp,
        },
        {
          type: "custom",
          id: `cache-${index}`,
          parentId: `message-${index}`,
          timestamp,
          customType: "openclaw.cache-ttl",
          display: true,
          message: { role: "toolResult" },
        },
      ];
    });
    for (const [index, entry] of entries.entries()) {
      seedClaim({ ...source, entry, events: events[index] });
    }
    const snapshot = (target: ClaimTarget) =>
      transaction(
        target,
        ({ db }) => ({
          windows: db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
          events: db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
          identities: db
            .prepare("SELECT * FROM transcript_event_identities ORDER BY session_id, event_id")
            .all(),
        }),
        fixture.env,
      );
    if (kind === "cold") {
      updateWindow(source, "transcript_updated_at = 1", fixture.env);
    }
    const before = snapshot(source);
    expect([before.windows.length, before.events.length]).toEqual([3, 9]);
    if (kind === "utf16") {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      {
        using database = new DatabaseSync(destinationPath);
        database.exec(`PRAGMA encoding = 'UTF-16le';
            CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`);
      }
      transaction(
        destination,
        ({ db }) => expect(db.prepare("PRAGMA encoding").get()?.encoding).toBe("UTF-16le"),
        fixture.env,
      );
    }
    if (kind === "existing-current") {
      seedClaim({ ...destination, entry: entries[2], events: events[2] });
      updateWindow(
        destination,
        "row_transcript_json = NULL, row_transcript_updated_at = NULL",
        fixture.env,
      );
    }
    const existingBefore = kind === "existing-current" ? snapshot(destination) : undefined;
    if (kind === "cold") {
      const archived = await archiveCold(source.databasePath);
      expect(archived.archivedTranscripts).toBeGreaterThan(0);
    }

    expect(await repair(fixture)).toMatchObject({ complete: true });
    const after = snapshot(destination);
    expect(after).toEqual({
      windows: before.windows.map(
        (window) =>
          existingBefore?.windows.find((existing) => existing.session_id === window.session_id) ?? {
            ...window,
            session_key: canonicalKey,
          },
      ),
      events:
        kind === "utf16"
          ? before.events.map((event) => ({ ...event, event_utf8_bytes: null }))
          : before.events,
      identities: before.identities,
    });
    expect(after.events.filter((event) => event.seq === 2)).toEqual(
      ids.map(() =>
        expect.objectContaining({
          navigation_type: "custom",
          navigation_custom_type: "openclaw.cache-ttl",
          navigation_display: 1,
          message_role: "toolResult",
          navigation_last_type: "custom",
          navigation_last_custom_type: "openclaw.cache-ttl",
          navigation_valid: 1,
        }),
      ),
    );
    expect(snapshot(source)).toEqual({ windows: [], events: [], identities: [] });
    expect(readClaim(destination)?.entry).toMatchObject(entries[2]!);
    for (const [index, sessionId] of ids.entries()) {
      expect(
        readHistoryPage(historyScope(fixture, destination, sessionId), {
          messageId: `message-${index}`,
          maxMessages: 2,
        }).found,
      ).toBe(true);
    }
    expect(await repair(fixture)).toMatchObject({ ledgerComplete: true });
    expect(snapshot(destination)).toEqual(after);
  },
);

it("preserves the verified cold archive during an in-place key migration", async () => {
  const fixture = createFixture();
  const storePath = path.join(fixture.stateDir, "shared.sqlite");
  fixture.cfg.session = { store: storePath };
  const canonicalKey = "agent:ops:chat";
  const sessionId = "cold-in-place";
  const source = claim(fixture, "main", "agent:main:chat", storePath);
  seedClaim({
    ...source,
    entry: { sessionId, updatedAt: 1 },
    events: [
      { type: "session", version: 3, id: sessionId, timestamp: new Date(1).toISOString() },
      {
        ...message("cold-question", "user", "Retain archived bytes: café 🦞"),
        timestamp: new Date(1).toISOString(),
      },
    ],
  });
  const options = { agentId: "main", path: storePath, env: fixture.env };
  const ageTranscript = "UPDATE session_windows SET transcript_updated_at = 1 WHERE session_id = ?";
  transaction(source, ({ db }) => db.prepare(ageTranscript).run(sessionId), fixture.env);
  const archived = await archiveCold(storePath);
  expect(archived.archivedTranscripts).toBe(1);
  const snapshot = (key: string) =>
    writeTransaction((database) => {
      const { db } = database;
      return {
        entry: readExactSessionEntryRowForCanonicalRepair(database, key)?.entry,
        windows: db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
        events: db.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
        archive: readSessionColdTranscript(db, sessionId),
        generation: db.prepare("SELECT * FROM transcript_rewrite_watermarks").get(),
      };
    }, options);
  const before = snapshot(source.key);
  expect(before.events).toEqual([]);
  if (!before.archive) {
    throw new Error("Expected a verified cold archive before in-place migration");
  }
  const archive = { ...before.archive, archive_blob: null };
  const bytes = await readVerifiedSessionColdArchive({ storePath, archive });

  expect(await repair(fixture)).toMatchObject({ complete: true });
  const after = snapshot(canonicalKey);
  expect(after).toEqual({
    ...before,
    windows: before.windows.map((row) => Object.assign({}, row, { session_key: canonicalKey })),
  });
  await expect(readVerifiedSessionColdArchive({ storePath, archive })).resolves.toEqual(bytes);
  expect(snapshot(source.key).entry).toBeUndefined();
});
