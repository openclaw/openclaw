import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal-reclamation.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import * as writeAdmission from "../../state/openclaw-agent-write-admission.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveRegisteredSqliteTranscriptArchiveName } from "./session-accessor.sqlite-archive-artifact.js";
import {
  readSqliteSessionArchivePruning,
  withSqliteSessionPageReclamation,
} from "./session-accessor.sqlite-page-reclamation.js";
import * as pageReclamation from "./session-accessor.sqlite-page-reclamation.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { pruneAllSessionTranscriptArchivesToHighWater } from "./session-history-archive-pruning.js";

afterEach(() => vi.restoreAllMocks());

function withBindingState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState(
    { prefix: "page-reclamation-binding-", scenario: "minimal", layout: "state-only" },
    run,
  );
}

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
  const hash = createHash("sha256").update(content).digest("hex");
  ensureSessionTranscriptArchiveSchema(database.db);
  database.db
    .prepare(`INSERT INTO session_transcript_archives
    (archive_blob, archive_name, archive_sha256, created_at, encoding, generation,
     published_at, reason, session_id, session_key)
    VALUES (?, ?, ?, ?, 'identity', ?, ?, 'deleted', ?, 'agent:main:binding-history')`)
    .run(content, archiveName, hash, createdAt, generation, createdAt, sessionId);
  fs.mkdirSync(archiveDirectory, { recursive: true });
  const archivePath = path.join(archiveDirectory, archiveName);
  fs.writeFileSync(archivePath, content);
  const rows = readArchives(database);
  return {
    archivePath,
    assertRetained() {
      expect(readArchives(database)).toEqual(rows);
      expect(fs.readFileSync(archivePath)).toEqual(content);
    },
  };
}

function readArchives(database: OpenClawAgentDatabase) {
  return database.db
    .prepare(`SELECT archive_name, archive_sha256, generation, published_at, session_id
    FROM session_transcript_archives`)
    .all();
}

const prune = (
  databaseOptions: ReturnType<typeof resolveSessionReclamationDatabaseOptions>,
  archiveDirectory: string,
) =>
  pruneAllSessionTranscriptArchivesToHighWater({
    databaseOptions,
    archiveDirectory,
    highWaterBytes: 0,
    storePath: databaseOptions.path,
  });

it.each([
  { operation: "prune", retirement: "path" },
  { operation: "prune", retirement: "root" },
  { operation: "preview", retirement: "path" },
])(
  "retires archive pruning owners by the symlinked $retirement its requester used ($operation)",
  async ({ operation, retirement }) => {
    await withBindingState(async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      const archiveDirectory = state.sessionsDir();
      seedArchive(database, archiveDirectory);
      await closeOpenClawAgentDatabaseByPathAsync(database.path);
      const link = path.join(state.root, "state-link");
      assert.ok(state.env.OPENCLAW_STATE_DIR);
      fs.symlinkSync(
        state.env.OPENCLAW_STATE_DIR,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
      const linkOptions = resolveSessionReclamationDatabaseOptions({
        agentId: "main",
        env: { ...state.env, OPENCLAW_STATE_DIR: link },
      });
      if (operation === "prune") {
        await expect(prune(linkOptions, archiveDirectory)).resolves.toMatchObject({
          removedFiles: 1,
        });
      } else {
        expect((await readSqliteSessionArchivePruning(linkOptions))?.archives).toHaveLength(1);
      }
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(true);
      if (retirement === "path") {
        await closeOpenClawAgentDatabaseByPathAsync(linkOptions.path, "main");
      } else {
        await closeOpenClawAgentDatabasesAsync(link);
      }
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    });
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "keeps archive pruning on its captured database (retargeted alias: %s)",
  async (retarget) => {
    await withBindingState(async (state) => {
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
      const pending = prune(aliasOptions, archiveDirectory);
      if (retarget) {
        await expect(pending).rejects.toThrow("file identity changed");
      } else {
        await expect(pending).resolves.toMatchObject({ removedFiles: 1 });
      }
      expect(captured).toBe(true);
      if (retarget) {
        archive.assertRetained();
      } else {
        expect(readArchives(archiveDatabase)).toEqual([]);
        expect(fs.existsSync(archive.archivePath)).toBe(false);
      }
    });
  },
);

it.runIf(process.platform !== "win32").each([false, true])(
  "revalidates the original alias after worker write admission queues (retargeted alias: %s)",
  async (retarget) => {
    let fixtureRoot = "";
    await withBindingState(async (state) => {
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
          if (observing && !("target" in args[0]) && args[0].path === preparedPath) {
            requested.resolve();
          }
          return result;
        },
      );
      const pending = withSqliteSessionPageReclamation(
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
      if (retarget) {
        await expect(pending).rejects.toThrow("file identity changed");
      } else {
        await expect(pending).resolves.toMatchObject({
          checkpointCompleted: true,
          vacuumPasses: 1,
        });
      }
      originalArchive.assertRetained();
      replacementArchive.assertRetained();
      if (retarget) {
        expect(readFreePages()).toBe(freePagesBefore);
      } else {
        expect(readFreePages()).toBeLessThan(freePagesBefore);
      }
    });
    expect(fs.existsSync(fixtureRoot)).toBe(false);
  },
);
