import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { publishSessionStateArchivesInWorker } from "./session-accessor.sqlite-archive-store.js";
import type {
  TranscriptArchivePublishWorkerMessage,
  TranscriptArchiveWorkerMessage,
} from "./session-accessor.sqlite-archive-types.js";
import { applySessionEntryExactReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "./session-transcript-reconcile.js";

export function registerArchivePublicationRecoveryTests(
  getScope: () => { storePath: string; tempDir: string },
  archiveScopeHooks: { beforeExport: (() => Promise<void>) | undefined },
) {
  for (const { failure, name } of [
    {
      failure: "file collision",
      name: "joins a failed publisher and recovers its committed archive after file collision",
    },
    {
      failure: "result recording",
      name: "joins a failed publisher and recovers its committed archive after result recording",
    },
    ...(process.platform === "win32"
      ? []
      : [
          {
            failure: "physical replacement",
            name: "refuses maintenance archive export from a physically replaced database",
          },
        ]),
  ]) {
    it(name, async ({ signal }) => {
      const { storePath, tempDir } = getScope();
      const sessionKey = "agent:main:scoped-publish-failure";
      const writerKey = "agent:main:archive-foreground-writer";
      if (failure === "file collision") {
        await replaceSessionEntry(
          { sessionKey: writerKey, storePath },
          { sessionId: "archive-foreground-writer", updatedAt: Date.now() },
        );
      }
      const sessionIds = ["scoped-publish-history", "scoped-publish-current"] as const;
      const events = sessionIds.map((sessionId) =>
        createTranscriptEvent(sessionId, "recover exact bytes"),
      );
      for (const [index, sessionId] of sessionIds.entries()) {
        await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: index + 1 });
        await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [events[index]!]);
      }
      await waitForSessionTranscriptIndexReconcilesInStateDir(tempDir);
      let collisionPath: string | undefined;
      const archiveWorkers = observeArchiveSessionWorkers((message) => {
        if (message.type === "done" && !collisionPath) {
          const archiveName = message.results[0]?.archive?.archiveName;
          if (archiveName) {
            collisionPath = path.join(path.dirname(storePath), archiveName);
            fs.writeFileSync(collisionPath, "conflicting derived file");
          }
        }
      });
      const deletionParams = {
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      };
      try {
        await expect(deleteSessionEntryLifecycle(deletionParams)).rejects.toThrow(
          "transcript archive file export(s) remain pending in SQLite",
        );
      } finally {
        archiveWorkers.stop();
      }

      expect(archiveWorkers.replies.map(({ message }) => message.type)).toEqual([
        "done",
        "published",
      ]);
      expect(new Set(archiveWorkers.replies.map(({ worker }) => worker)).size).toBe(1);
      expect(archiveWorkers.replies.every(({ worker }) => worker.threadId === -1)).toBe(true);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        sessionId: sessionIds[1],
      });
      await expect(
        loadTranscriptEvents({ sessionKey, sessionId: sessionIds[0], storePath }),
      ).resolves.toEqual([]);
      await expect(
        loadTranscriptEvents({ sessionKey, sessionId: sessionIds[1], storePath }),
      ).resolves.toEqual([events[1]]);
      expect(
        openLifecycleTestDatabase(storePath)
          .db.prepare(
            "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
          )
          .get(sessionIds[0]!),
      ).toEqual({ published_at: null, last_publish_error: expect.stringContaining("collision") });
      expect(collisionPath).toBeDefined();
      fs.rmSync(collisionPath!);
      if (failure !== "result recording") {
        const database = openLifecycleTestDatabase(storePath);
        const databaseIdentity = readOpenClawAgentDatabaseIdentity(database).identity;
        if (typeof databaseIdentity !== "string") {
          throw new Error("expected a durable archive database");
        }
        const readPublication = () =>
          executeSqliteQueryTakeFirstSync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_transcript_archives")
              .select("published_at")
              .where("session_id", "=", sessionIds[0]),
          );
        const exportEntered = createDeferred();
        const releaseExport = createDeferred();
        archiveScopeHooks.beforeExport = async () => {
          exportEntered.resolve();
          await releaseExport.promise;
        };
        const publicationWorkers = observeArchiveSessionWorkers();
        let publicationCompleted = false;
        const publication = publishSessionStateArchivesInWorker(
          { agentId: "main", path: database.path },
          databaseIdentity,
          [],
          () => signal.throwIfAborted(),
        ).then((result) => {
          publicationCompleted = true;
          return result;
        });
        let writer: Promise<void> | undefined;
        const replacementPath = path.join(tempDir, "maintenance-replacement.sqlite");
        const heldPath = `${database.path}.held`;
        let replaced = false;
        try {
          await racePromiseWithAbortSignal(
            Promise.race([
              exportEntered.promise,
              publication.then(() => {
                throw new Error("archive publication skipped file export");
              }),
            ]),
            signal,
          );
          if (failure === "physical replacement") {
            // Keep the same valid pending SID/generation so only the physical owner differs.
            database.db.prepare("VACUUM INTO ?").run(replacementPath);
            const replacementBytes = fs.readFileSync(replacementPath);
            fs.renameSync(database.path, heldPath);
            fs.renameSync(replacementPath, database.path);
            replaced = true;
            releaseExport.resolve();
            const publicationError = await publication.then(
              () => undefined,
              (error: unknown) => error,
            );
            expect(fs.existsSync(collisionPath!)).toBe(false);
            expect(publicationError).toBeInstanceOf(Error);
            expect(publicationError).toMatchObject({
              message: expect.stringMatching(/identity|replaced/),
            });
            expect(fs.readFileSync(database.path)).toEqual(replacementBytes);
            expect(readPublication()).toEqual({ published_at: null });
          } else {
            writer = applySessionEntryExactReplacements({
              agentId: "main",
              storePath,
              sessionKeys: [writerKey],
              skipMaintenance: true,
              update: ([row]) => {
                if (!row) {
                  throw new Error("expected the foreground writer session");
                }
                return {
                  result: undefined,
                  replacements: [
                    { sessionKey: writerKey, entry: { ...row.entry, label: "progressed" } },
                  ],
                };
              },
            });
            await racePromiseWithAbortSignal(writer, signal);
            expect(loadSessionEntry({ sessionKey: writerKey, storePath })?.label).toBe(
              "progressed",
            );
            expect(publicationCompleted).toBe(false);
            expect(readPublication()).toEqual({ published_at: null });
            expect(fs.existsSync(collisionPath!)).toBe(false);
            releaseExport.resolve();
            await publication;
            expect(readPublication()).toEqual({ published_at: expect.any(Number) });
            expect(readArchiveLines(collisionPath)).toEqual([JSON.stringify(events[0])]);
            expect(publicationWorkers.replies.map(({ message }) => message.type)).toEqual([
              "published",
            ]);
            expect(publicationWorkers.replies.every(({ worker }) => worker.threadId === -1)).toBe(
              true,
            );
          }
        } finally {
          releaseExport.resolve();
          await Promise.allSettled([publication, writer]);
          if (replaced) {
            fs.renameSync(database.path, replacementPath);
            fs.renameSync(heldPath, database.path);
          }
          archiveScopeHooks.beforeExport = undefined;
          publicationWorkers.stop();
        }
      }
      if (failure === "result recording") {
        const database = openLifecycleTestDatabase(storePath);
        const readPending = () =>
          database.db
            .prepare(
              "SELECT published_at, last_publish_attempt_at, last_publish_error, publish_attempts FROM session_transcript_archives WHERE session_id = ?",
            )
            .get(sessionIds[0]);
        const pending = readPending();
        database.db.exec(`
        CREATE TRIGGER refuse_archive_result BEFORE UPDATE OF published_at
        ON session_transcript_archives BEGIN
          SELECT RAISE(ABORT, 'synthetic archive result recording failure');
        END;
      `);
        try {
          await expect(deleteSessionEntryLifecycle(deletionParams)).rejects.toThrow(
            "synthetic archive result recording failure",
          );
          expect(readArchiveLines(collisionPath)).toEqual([JSON.stringify(events[0])]);
          expect(readPending()).toEqual(pending);
          await expect(
            loadTranscriptEvents({ sessionKey, sessionId: sessionIds[0], storePath }),
          ).resolves.toEqual([]);
        } finally {
          database.db.exec("DROP TRIGGER refuse_archive_result");
        }
      }

      await expect(deleteSessionEntryLifecycle(deletionParams)).resolves.toMatchObject({
        deleted: failure !== "result recording",
      });
      expect(readArchiveLines(collisionPath)).toEqual([JSON.stringify(events[0])]);
      expect(
        openLifecycleTestDatabase(storePath)
          .db.prepare(
            "SELECT published_at, last_publish_error FROM session_transcript_archives WHERE session_id = ?",
          )
          .get(sessionIds[0]!),
      ).toEqual({ published_at: expect.any(Number), last_publish_error: null });
    });
  }
}

type ArchiveSessionReply = {
  operationId?: number;
  settled?: boolean;
} & (TranscriptArchiveWorkerMessage | TranscriptArchivePublishWorkerMessage);

export function observeArchiveSessionWorkers(
  onReply?: (message: ArchiveSessionReply, worker: Worker) => void,
) {
  const replies: Array<{ message: ArchiveSessionReply; worker: Worker }> = [];
  const observeWorker = (worker: Worker) => {
    worker.on("message", (message: ArchiveSessionReply | null | undefined) => {
      if (
        message &&
        (message.type === "done" || message.type === "published") &&
        Array.isArray(message.results)
      ) {
        replies.push({ message, worker });
        onReply?.(message, worker);
      }
    });
  };
  process.on("worker", observeWorker);
  return { replies, stop: () => process.off("worker", observeWorker) };
}

export function createTranscriptEvent(sessionId: string, content: string) {
  return { type: "session", id: sessionId, content };
}

export function readArchiveLines(archivePath: string | undefined): string[] {
  expect(archivePath).toBeTruthy();
  return readSessionArchiveContentSync(archivePath ?? "")
    .trim()
    .split("\n");
}

export function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
}
