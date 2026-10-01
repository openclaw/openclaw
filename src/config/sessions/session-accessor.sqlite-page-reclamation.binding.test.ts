import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal-reclamation.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveRegisteredSqliteTranscriptArchiveName } from "./session-accessor.sqlite-archive-artifact.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import * as pageReclamation from "./session-accessor.sqlite-page-reclamation.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import { pruneAllSessionTranscriptArchivesToHighWater } from "./session-history-archive-pruning.js";

afterEach(() => vi.restoreAllMocks());

function seedArchive(database: OpenClawAgentDatabase, archiveDirectory: string) {
  const sessionId = "binding-retained-history";
  const generation = "binding-generation";
  const createdAt = 1;
  const archiveName = resolveRegisteredSqliteTranscriptArchiveName({
    createdAt,
    encoding: "identity",
    generation,
    reason: "deleted",
    sessionId,
  });
  const content = Buffer.from("synthetic retained history\n");
  ensureSessionTranscriptArchiveSchema(database.db);
  executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .insertInto("session_transcript_archives")
      .values({
        archive_blob: content,
        archive_name: archiveName,
        archive_sha256: createHash("sha256").update(content).digest("hex"),
        created_at: createdAt,
        encoding: "identity",
        generation,
        published_at: createdAt,
        reason: "deleted",
        session_id: sessionId,
        session_key: "agent:main:binding-history",
      }),
  );
  fs.mkdirSync(archiveDirectory, { recursive: true });
  const archivePath = path.join(archiveDirectory, archiveName);
  fs.writeFileSync(archivePath, content);
  return { archivePath, content, sessionId };
}

function readArchives(database: OpenClawAgentDatabase) {
  return executeSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("session_transcript_archives")
      .select(["archive_name", "archive_sha256", "generation", "published_at", "session_id"]),
  ).rows;
}

it.runIf(process.platform !== "win32").each([false, true])(
  "keeps archive pruning on its captured database (retargeted alias: %s)",
  async (retarget) => {
    await withOpenClawTestState(
      { prefix: "page-reclamation-binding-", scenario: "minimal", layout: "state-only" },
      async (state) => {
        const options = { agentId: "main", env: state.env };
        const original = openOpenClawAgentDatabase(options);
        const replacement = retarget
          ? openOpenClawAgentDatabase({
              ...options,
              path: path.join(state.root, "replacement.sqlite"),
            })
          : undefined;
        const archiveDatabase = replacement ?? original;
        const archiveDirectory = state.sessionsDir();
        const archive = seedArchive(archiveDatabase, archiveDirectory);
        const before = readArchives(archiveDatabase);
        const alias = path.join(state.root, "alias.sqlite");
        fs.symlinkSync(original.path, alias);
        const aliasOptions = { ...options, path: alias };
        const withPages = pageReclamation.withSqliteSessionPageReclamation;
        let captured = false;
        vi.spyOn(pageReclamation, "withSqliteSessionPageReclamation").mockImplementation(
          <T>(...args: Parameters<typeof withPages<T>>) => {
            const [input, run] = args;
            return withPages(input, (...context) => {
              captured = true;
              if (replacement) {
                fs.unlinkSync(alias);
                fs.symlinkSync(replacement.path, alias);
              }
              return run(...context);
            });
          },
        );
        let failure: unknown;
        let removedFiles: number | undefined;
        try {
          const result = await pruneAllSessionTranscriptArchivesToHighWater({
            archiveDirectory,
            databaseOptions: aliasOptions,
            highWaterBytes: 0,
            storePath: alias,
          });
          removedFiles = result.removedFiles;
        } catch (error) {
          failure = error;
        }
        expect(captured).toBe(true);
        if (retarget) {
          expect(readArchives(archiveDatabase)).toEqual(before);
          expect(fs.readFileSync(archive.archivePath)).toEqual(archive.content);
          expect(failure).toBeInstanceOf(Error);
          expect(String(failure)).toContain("file identity changed");
        } else {
          expect(failure).toBeUndefined();
          expect(removedFiles).toBe(1);
          expect(readArchives(archiveDatabase)).toEqual([]);
          expect(fs.existsSync(archive.archivePath)).toBe(false);
        }
      },
    );
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "revalidates the original alias after worker write admission queues (retargeted alias: %s)",
  async (retarget) => {
    let fixtureRoot = "";
    await withOpenClawTestState(
      { prefix: "page-reclamation-queued-binding-", scenario: "minimal", layout: "state-only" },
      async (state) => {
        fixtureRoot = state.root;
        const options = { agentId: "main", env: state.env };
        const original = openOpenClawAgentDatabase(options);
        const replacement = openOpenClawAgentDatabase({
          ...options,
          path: path.join(state.root, "replacement.sqlite"),
        });
        const originalArchive = seedArchive(original, path.join(state.root, "original-archives"));
        const replacementArchive = seedArchive(
          replacement,
          path.join(state.root, "replacement-archives"),
        );
        const originalRows = readArchives(original);
        const replacementRows = readArchives(replacement);
        const pageSize = Number(original.db.prepare("PRAGMA page_size").get()?.page_size);
        // sqlite-allow-raw -- Synthetic free pages prove whether the real queued vacuum was authorized.
        original.db
          .prepare(
            "INSERT INTO cache_entries(scope, key, blob, updated_at) VALUES (?, ?, zeroblob(?), 1)",
          )
          .run("queued-binding", "free-pages", pageSize * 1024);
        original.db.prepare("DELETE FROM cache_entries WHERE scope = ?").run("queued-binding");
        expect(original.walMaintenance.checkpoint()).toBe(true);
        const readFreePages = () =>
          Number(original.db.prepare("PRAGMA freelist_count").get()?.freelist_count);
        const freePagesBefore = readFreePages();
        expect(freePagesBefore).toBeGreaterThan(512);
        const alias = path.join(state.root, "alias.sqlite");
        fs.symlinkSync(original.path, alias);
        const aliasOptions = { ...options, path: alias };
        const requested = createDeferred();
        let observing = false;
        let preparedPath: string | undefined;
        const write = writeAdmission.runOpenClawAgentWorkerWrite;
        vi.spyOn(writeAdmission, "runOpenClawAgentWorkerWrite").mockImplementation(
          <T>(...args: Parameters<typeof write<T>>) => {
            const result = write(...args);
            if (observing && args[0].path === preparedPath) {
              requested.resolve();
            }
            return result;
          },
        );
        let failure: unknown;
        let result: SqliteWalReclamationResult | undefined;
        try {
          result = await withSqliteSessionPageReclamation(
            aliasOptions,
            async (reclaimPages, _assertCurrent, preparedOptions) => {
              preparedPath = preparedOptions.path;
              const entered = createDeferred();
              const release = createDeferred();
              const blocker = runExclusiveSqliteSessionWrite(
                preparedOptions,
                async () => {
                  entered.resolve();
                  await release.promise;
                },
                "session.transcript.batch",
              );
              void blocker.catch(entered.reject);
              let reclamation: Promise<SqliteWalReclamationResult> | undefined;
              try {
                await entered.promise;
                observing = true;
                reclamation = reclaimPages(1);
                void reclamation.catch(() => {});
                await withTestTimeout(requested.promise, 10_000, "Page write was not queued");
                if (retarget) {
                  fs.unlinkSync(alias);
                  fs.symlinkSync(replacement.path, alias);
                }
                release.resolve();
                return await reclamation;
              } finally {
                observing = false;
                release.resolve();
                await Promise.allSettled([blocker, reclamation]);
              }
            },
          );
        } catch (error) {
          failure = error;
        }
        expect(readArchives(original)).toEqual(originalRows);
        expect(readArchives(replacement)).toEqual(replacementRows);
        expect(fs.readFileSync(originalArchive.archivePath)).toEqual(originalArchive.content);
        expect(fs.readFileSync(replacementArchive.archivePath)).toEqual(replacementArchive.content);
        if (retarget) {
          expect(readFreePages()).toBe(freePagesBefore);
          expect(failure).toBeInstanceOf(Error);
          expect(String(failure)).toContain("file identity changed");
        } else {
          expect(failure).toBeUndefined();
          expect(result).toMatchObject({ checkpointCompleted: true, vacuumPasses: 1 });
          expect(readFreePages()).toBeLessThan(freePagesBefore);
        }
      },
    );
    expect(fs.existsSync(fixtureRoot)).toBe(false);
  },
);
