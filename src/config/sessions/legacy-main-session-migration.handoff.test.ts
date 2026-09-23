import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { migrateLegacyMainSessionKeys } from "./legacy-main-session-migration.js";
import {
  assignHumanOwner,
  databasePath,
  humanOwner,
  outcomeKinds,
  readClaim,
  recordHarnessDeletions,
  seedClaim,
  setupLegacyMainSessionMigrationTests,
} from "./legacy-main-session-migration.test-support.js";
import { deleteSessionEntryLifecycle } from "./session-accessor.js";
import { readExactSessionEntryRowForCanonicalRepair } from "./session-accessor.sqlite-canonical-repair.js";
import { readSessionTranscriptHistoryAnchorPage } from "./session-accessor.sqlite-history.test-support.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { rotateTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readVerifiedSessionColdArchive } from "./session-cold-storage-codec.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "./session-cold-storage.js";
import type { SessionEntry } from "./types.js";

const { tempDirs, createFixture } = setupLegacyMainSessionMigrationTests();

describe("legacy main session history handoff", () => {
  it("refuses cleanup rebound to an identical destination database", async () => {
    const fixture = createFixture();
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    const entry = { sessionId: "rebound-source", updatedAt: 100 };
    const source = {
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      key: "agent:ops:chat",
    };
    const destination = {
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      key: source.key,
    };
    seedClaim({ ...source, entry });
    seedClaim({ ...destination, entry });
    const before = [readClaim(source), readClaim(destination)];
    expect(before[0]?.entry).toEqual(before[1]?.entry);
    const expectedDatabaseIdentity = runOpenClawAgentWriteTransaction(
      (database) => readOpenClawAgentDatabaseIdentity(database).identity,
      { agentId: source.databaseAgentId, path: source.databasePath },
    );
    const deletion = {
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
      expectedEntry: before[0]!.entry,
      expectedDatabaseIdentity,
      target: { canonicalKey: source.key, storeKeys: [source.key] },
    };

    await expect(
      deleteSessionEntryLifecycle({
        ...deletion,
        agentId: destination.databaseAgentId,
        storePath: destination.databasePath,
      }),
    ).resolves.toMatchObject({ deleted: false, expectedEntryMismatch: true });
    expect([readClaim(source), readClaim(destination)]).toEqual(before);
    await expect(
      deleteSessionEntryLifecycle({
        ...deletion,
        agentId: source.databaseAgentId,
        storePath: source.databasePath,
      }),
    ).resolves.toMatchObject({ deleted: true });
    expect(readClaim(destination)).toEqual(before[1]);
  });

  it("cleans a foreign logical claim from its physical partition without bypassing active work", async () => {
    const fixture = createFixture();
    const storePath = path.join(fixture.stateDir, "shared.json");
    fixture.cfg = {
      agents: {
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, beta: {} },
      },
      session: { store: storePath },
    };
    const source = {
      databaseAgentId: "beta",
      databasePath: path.join(fixture.stateDir, "shared.beta.sqlite"),
      key: "agent:main:chat",
    };
    const destination = {
      databaseAgentId: "ops",
      databasePath: path.join(fixture.stateDir, "shared.sqlite"),
      key: "agent:ops:chat",
    };
    const sibling = { ...destination, key: "agent:ops:keep" };
    seedClaim(sibling);
    const entry = seedClaim({ ...source, events: [{ kind: "repeat" }, { kind: "repeat" }] });
    const sourceBefore = readClaim(source);
    const siblingBefore = readClaim(sibling);
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [source.key, entry.sessionId],
      assertAllowed: () => {},
    });
    try {
      await expect(
        migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: "doctor-fix",
        }),
      ).rejects.toThrow("competing work is in flight");
      expect(readClaim(source)).toEqual(sourceBefore);
    } finally {
      admission.release();
    }

    const repaired = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });
    const retry = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    expect(repaired.complete).toBe(true);
    expect(retry.ledgerComplete).toBe(true);
    expect(readClaim(source)).toBeUndefined();
    expect(readClaim(destination)?.entry).toMatchObject(entry);
    expect(readClaim(destination)?.events).toEqual(sourceBefore?.events);
    expect(readClaim(sibling)).toEqual(siblingBefore);
    expect(fs.existsSync(path.join(fixture.stateDir, "shared.main.sqlite"))).toBe(false);
  });

  it("imports a new fixed-store destination at its planned path and owner on the first attempt", async () => {
    const fixture = createFixture();
    const storePath = path.join(fixture.stateDir, "shared.json");
    fixture.cfg.session = { store: storePath };
    const source = {
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      key: "agent:main:chat",
    };
    const sibling = { ...source, key: "agent:other:keep" };
    const entry = seedClaim({ ...source, events: [{ kind: "repeat" }, { kind: "repeat" }] });
    seedClaim(sibling);
    const sourceBefore = readClaim(source);
    const siblingBefore = readClaim(sibling);
    const destination = {
      databaseAgentId: "ops",
      databasePath: path.join(fixture.stateDir, "shared.sqlite"),
      key: "agent:ops:chat",
    };

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });
    const retry = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    expect(result.complete).toBe(true);
    expect(outcomeKinds(result)).toContain("migrated-cross-store");
    expect(retry.ledgerComplete).toBe(true);
    expect(readClaim(source)).toBeUndefined();
    expect(readClaim(destination)?.entry).toMatchObject(entry);
    expect(readClaim(destination)?.events).toEqual(sourceBefore?.events);
    expect(readClaim(sibling)).toEqual(siblingBefore);
    expect(fs.existsSync(path.join(fixture.stateDir, "shared.ops.sqlite"))).toBe(false);
    expect(fs.existsSync(storePath)).toBe(false);
    expect(
      runOpenClawAgentWriteTransaction(
        (database) => readTranscriptEventRows(database, entry.sessionId),
        { agentId: source.databaseAgentId, path: source.databasePath },
      ),
    ).toEqual([]);
  });

  it.each([
    { kind: "migrated-in-place", sharedStore: true },
    { kind: "migrated-cross-store", sharedStore: false },
  ])("preserves the assigned human owner when $kind", async ({ kind, sharedStore }) => {
    const storePath = sharedStore
      ? path.join(tempDirs.make("owned-in-place-migration-"), "sessions.sqlite")
      : undefined;
    const fixture = createFixture({
      agents: { entries: { ops: {} } },
      ...(storePath ? { session: { store: storePath } } : {}),
    });
    const sourcePath = storePath ?? databasePath(fixture.stateDir, "main");
    seedClaim({ databaseAgentId: "main", databasePath: sourcePath, key: "agent:main:chat" });
    assignHumanOwner(sourcePath);

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    expect(result.complete).toBe(true);
    expect(outcomeKinds(result)).toContain(kind);
    expect(
      readClaim({
        databaseAgentId: sharedStore ? "main" : "ops",
        databasePath: storePath ?? databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      })?.entry.owner,
    ).toEqual(humanOwner);
    expect(
      readClaim({ databaseAgentId: "main", databasePath: sourcePath, key: "agent:main:chat" }),
    ).toBeUndefined();
  });

  it("preserves anchored history and recorded idempotency ownership across stores", async () => {
    const fixture = createFixture();
    const sourcePath = databasePath(fixture.stateDir, "main");
    const destinationPath = databasePath(fixture.stateDir, "ops");
    const sessionId = "identity-transfer";
    const sourceKey = "agent:main:chat";
    const source = { agentId: "main", path: sourcePath, sessionId, sessionKey: sourceKey };
    seedClaim({
      databaseAgentId: "main",
      databasePath: sourcePath,
      key: sourceKey,
      entry: { sessionId, updatedAt: 100 },
      events: [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "question",
          parentId: null,
          message: { role: "user", content: "Preserve this migrated question." },
        },
        {
          type: "message",
          id: "earlier-answer",
          parentId: "question",
          message: { role: "assistant", content: "Earlier answer.", idempotencyKey: "answer-key" },
        },
      ],
    });
    const expectedIdentities = runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventInTransaction(
          database,
          source,
          {
            type: "message",
            id: "latest-answer",
            parentId: "earlier-answer",
            message: { role: "assistant", content: "Latest answer.", idempotencyKey: "answer-key" },
          },
          { allowStoredAlias: true, idempotencyKeyMode: "relocate-owner" },
        );
        return database.db
          .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
          .all(sessionId);
      },
      { agentId: "main", path: sourcePath },
    );
    const before = readClaim({ databaseAgentId: "main", databasePath: sourcePath, key: sourceKey });
    expect(expectedIdentities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_id: "earlier-answer", message_idempotency_key: null }),
        expect.objectContaining({
          event_id: "latest-answer",
          message_idempotency_key: "answer-key",
        }),
      ]),
    );

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    expect(result.complete).toBe(true);
    const scope = {
      agentId: "ops",
      env: fixture.env,
      storePath: destinationPath,
      sessionId,
      sessionKey: "agent:ops:chat",
    };
    expect(
      readSessionTranscriptHistoryAnchorPage(scope, { messageId: "question", maxMessages: 3 }),
    ).toMatchObject({ found: true });
    const destination = {
      databaseAgentId: "ops",
      databasePath: destinationPath,
      key: scope.sessionKey,
    };
    expect(readClaim(destination)?.events).toEqual(before?.events);
    expect(
      runOpenClawAgentWriteTransaction(
        (database) =>
          database.db
            .prepare("SELECT * FROM transcript_event_identities WHERE session_id = ? ORDER BY seq")
            .all(sessionId),
        { agentId: "ops", path: destinationPath },
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
    const source = {
      databaseAgentId: "main",
      databasePath: databasePath(fixture.stateDir, "main"),
      key: "agent:main:chat",
    };
    const destination = {
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      key: "agent:ops:chat",
    };
    const entry = { sessionId: "identity-conflict", updatedAt: 100 };
    const events = [
      {
        type: "message",
        id: "answer",
        parentId: null,
        message: {
          role: "assistant",
          content: "Unchanged answer bytes.",
          idempotencyKey: "recorded-owner",
        },
      },
    ];
    seedClaim({ ...source, entry, events });
    const beforeCopy = phase === "before-copy" || phase === "destination-watermark-missing";
    if (beforeCopy) {
      seedClaim({ ...destination, entry, events });
    }
    const before = readClaim(source);
    let changed = false;
    const changeOwnership = () => {
      if (!changed) {
        changed = true;
        if (phase === "destination-disposal") {
          expect(closeOpenClawAgentDatabaseByPath(destination.databasePath)).toBe(true);
          return;
        }
        const target = phase.startsWith("destination-") ? destination : source;
        runOpenClawAgentWriteTransaction(
          (database) => {
            if (
              phase === "destination-watermark-delete" ||
              phase === "destination-watermark-missing"
            ) {
              database.db
                .prepare("DELETE FROM transcript_rewrite_watermarks WHERE session_id = ?")
                .run(entry.sessionId);
              return;
            }
            if (phase === "destination-watermark-replace") {
              rotateTranscriptGenerationInTransaction(database, entry.sessionId);
              return;
            }
            database.db
              .prepare(
                "UPDATE transcript_event_identities SET message_idempotency_key = NULL WHERE session_id = ? AND event_id = 'answer'",
              )
              .run(entry.sessionId);
          },
          { agentId: target.databaseAgentId, path: target.databasePath },
        );
      }
    };
    if (beforeCopy) {
      changeOwnership();
    }
    const { committed } = await recordHarnessDeletions(
      async () => {
        const migration = migrateLegacyMainSessionKeys({
          cfg: fixture.cfg,
          env: fixture.env,
          mode: beforeCopy ? "detect" : "doctor-fix",
        });
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

  it.each(["fresh", "existing-current", "cold"] as const)(
    "preserves every retained generation through a %s cross-store handoff",
    async (kind) => {
      const fixture = createFixture();
      vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
      const sourcePath = databasePath(fixture.stateDir, "main");
      const destinationPath = databasePath(fixture.stateDir, "ops");
      const sourceKey = "agent:main:chat";
      const canonicalKey = "agent:ops:chat";
      const ids = ["retained-first", "retained-previous", "current"];
      const entries = ids.map((sessionId, index) => ({
        sessionId,
        updatedAt: index + 1,
        ...(index > 0 ? { previousSessionId: ids[index - 1] } : {}),
      }));
      const events = ids.map((sessionId, index) => [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: new Date(index + 1).toISOString(),
        },
        {
          type: "message",
          id: `message-${index}`,
          parentId: null,
          timestamp: new Date(index + 1).toISOString(),
          message: { role: "user", content: `Retained exact history ${index}: café 🦞` },
        },
      ]);
      for (const [index, entry] of entries.entries()) {
        seedClaim({
          databaseAgentId: "main",
          databasePath: sourcePath,
          key: sourceKey,
          entry,
          events: events[index],
        });
      }
      const snapshot = (agentId: string, pathname: string) =>
        runOpenClawAgentWriteTransaction(
          ({ db }) => ({
            windows: db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
            events: db.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
            identities: db
              .prepare("SELECT * FROM transcript_event_identities ORDER BY session_id, event_id")
              .all(),
          }),
          { agentId, path: pathname, env: fixture.env },
        );
      if (kind === "cold") {
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            db.prepare(
              "UPDATE session_windows SET transcript_updated_at = 1 WHERE session_key = ?",
            ).run(sourceKey);
          },
          { agentId: "main", path: sourcePath, env: fixture.env },
        );
      }
      const before = snapshot("main", sourcePath);
      expect(before.windows).toHaveLength(3);
      expect(before.events).toHaveLength(6);
      if (kind === "existing-current") {
        seedClaim({
          databaseAgentId: "ops",
          databasePath: destinationPath,
          key: canonicalKey,
          entry: entries[2],
          events: events[2],
        });
      }
      const existingBefore =
        kind === "existing-current" ? snapshot("ops", destinationPath) : undefined;
      if (kind === "cold") {
        const archived = await runSessionColdStorageMaintenance({
          config: {
            agents: { entries: { main: {} } },
            session: {
              store: sourcePath,
              maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
            },
          },
        });
        expect(archived.archivedTranscripts).toBeGreaterThan(0);
      }

      const result = await migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env: fixture.env,
        mode: "doctor-fix",
      });

      expect(result.complete).toBe(true);
      const after = snapshot("ops", destinationPath);
      expect(after.windows).toEqual(
        before.windows.map(
          (window) =>
            existingBefore?.windows.find(
              (existing) => existing.session_id === window.session_id,
            ) ?? { ...window, session_key: canonicalKey },
        ),
      );
      expect(after.events).toEqual(before.events);
      expect(after.identities).toEqual(before.identities);
      expect(snapshot("main", sourcePath)).toEqual({ windows: [], events: [], identities: [] });
      expect(
        readClaim({ databaseAgentId: "ops", databasePath: destinationPath, key: canonicalKey })
          ?.entry,
      ).toMatchObject(entries[2]!);
      for (const [index, sessionId] of ids.entries()) {
        expect(
          readSessionTranscriptHistoryAnchorPage(
            {
              agentId: "ops",
              env: fixture.env,
              storePath: destinationPath,
              sessionKey: canonicalKey,
              sessionId,
            },
            { messageId: `message-${index}`, maxMessages: 2 },
          ).found,
        ).toBe(true);
      }
      const retry = await migrateLegacyMainSessionKeys({
        cfg: fixture.cfg,
        env: fixture.env,
        mode: "doctor-fix",
      });
      expect(retry.ledgerComplete).toBe(true);
      expect(snapshot("ops", destinationPath)).toEqual(after);
    },
  );

  it.each([
    { copiedBeforeCrash: true, label: "copy committed before source cleanup" },
    { copiedBeforeCrash: false, label: "source cleanup committed before ledger" },
  ])("converges when $label", async ({ copiedBeforeCrash }) => {
    const fixture = createFixture();
    const entry: SessionEntry = { sessionId: "crash-window", updatedAt: 100 };
    if (copiedBeforeCrash) {
      seedClaim({
        databaseAgentId: "main",
        databasePath: databasePath(fixture.stateDir, "main"),
        entry,
        key: "agent:main:chat",
      });
    }
    seedClaim({
      databaseAgentId: "ops",
      databasePath: databasePath(fixture.stateDir, "ops"),
      entry,
      key: "agent:ops:chat",
    });

    const converged = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });
    const ledgerRerun = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "detect",
    });

    expect(converged.complete).toBe(true);
    expect(
      readClaim({
        databaseAgentId: "main",
        databasePath: databasePath(fixture.stateDir, "main"),
        key: "agent:main:chat",
      }),
    ).toBeUndefined();
    expect(
      readClaim({
        databaseAgentId: "ops",
        databasePath: databasePath(fixture.stateDir, "ops"),
        key: "agent:ops:chat",
      }),
    ).toBeDefined();
    expect(ledgerRerun.outcomes).toEqual([
      { kind: "no-legacy-rows", detail: "matching completed ledger" },
    ]);
  });

  it("preserves the verified cold archive during an in-place key migration", async () => {
    const fixture = createFixture();
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    const storePath = path.join(fixture.stateDir, "shared.sqlite");
    fixture.cfg.session = { store: storePath };
    const sourceKey = "agent:main:chat";
    const canonicalKey = "agent:ops:chat";
    const sessionId = "cold-in-place";
    seedClaim({
      databaseAgentId: "main",
      databasePath: storePath,
      key: sourceKey,
      entry: { sessionId, updatedAt: 1 },
      events: [
        { type: "session", version: 3, id: sessionId, timestamp: new Date(1).toISOString() },
        {
          type: "message",
          id: "cold-question",
          parentId: null,
          timestamp: new Date(1).toISOString(),
          message: { role: "user", content: "Retain archived bytes: café 🦞" },
        },
      ],
    });
    const options = { agentId: "main", path: storePath, env: fixture.env };
    runOpenClawAgentWriteTransaction(({ db }) => {
      db.prepare("UPDATE session_windows SET transcript_updated_at = 1 WHERE session_id = ?").run(
        sessionId,
      );
    }, options);
    const archived = await runSessionColdStorageMaintenance({
      config: {
        agents: { entries: { main: {} } },
        session: {
          store: storePath,
          maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
        },
      },
    });
    expect(archived.archivedTranscripts).toBe(1);
    const snapshot = (key: string) =>
      runOpenClawAgentWriteTransaction(
        (database) => ({
          entry: readExactSessionEntryRowForCanonicalRepair(database, key)?.entry,
          windows: database.db.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
          events: database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
          archive: readSessionColdTranscript(database.db, sessionId),
          generation: database.db.prepare("SELECT * FROM transcript_rewrite_watermarks").get(),
        }),
        options,
      );
    const before = snapshot(sourceKey);
    expect(before.events).toEqual([]);
    if (!before.archive) {
      throw new Error("Expected a verified cold archive before in-place migration");
    }
    const archive = { ...before.archive, archive_blob: null };
    const bytes = await readVerifiedSessionColdArchive({ storePath, archive });

    const result = await migrateLegacyMainSessionKeys({
      cfg: fixture.cfg,
      env: fixture.env,
      mode: "doctor-fix",
    });

    expect(result.complete).toBe(true);
    const after = snapshot(canonicalKey);
    expect(after).toEqual({
      ...before,
      windows: before.windows.map((window) =>
        Object.assign({}, window, { session_key: canonicalKey }),
      ),
    });
    await expect(readVerifiedSessionColdArchive({ storePath, archive })).resolves.toEqual(bytes);
    expect(snapshot(sourceKey).entry).toBeUndefined();
  });
});
