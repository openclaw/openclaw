import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { readPersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
} from "../config/sessions/session-history-read.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { listDirectoryTreeStrict } from "../infra/directory-walk.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { createNonExitingRuntime } from "../runtime.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "../state/openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { handleReset } from "./onboard-helpers.js";
import { resetCommand } from "./reset.js";

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ isLoaded: async () => false }),
}));

function silentRuntime() {
  const runtime = { ...createNonExitingRuntime(), log: vi.fn(), error: vi.fn() };
  return { runtime, log: runtime.log, error: runtime.error };
}

function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectFileText(filename: string, contents: string) {
  return expect(fs.readFile(filename, "utf8")).resolves.toBe(contents);
}

async function expectMissing(...filenames: string[]) {
  for (const filename of filenames) {
    await expect(fs.access(filename)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

function sessionScope(state: OpenClawTestState, agentId = "main", storePath?: string) {
  return {
    agentId,
    sessionKey: `agent:${agentId}:chat`,
    storePath: storePath ?? path.join(state.agentDir(agentId), "openclaw-agent.sqlite"),
  };
}

async function seedTranscript(
  scope: ReturnType<typeof sessionScope>,
  sessionId: string,
  events: Parameters<typeof replaceTranscriptEvents>[1] = [],
) {
  await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
  await replaceTranscriptEvents({ ...scope, sessionId }, [
    { type: "session", id: sessionId, version: 3 },
    ...events,
  ]);
}

function writeSessions(
  options: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  build: (db: ReturnType<typeof getSessionKysely>) => Parameters<typeof executeSqliteQuerySync>[1],
) {
  runOpenClawAgentWriteTransaction(({ db }) => {
    executeSqliteQuerySync(db, build(getSessionKysely(db)));
  }, options);
}

function reset(runtime: Parameters<typeof resetCommand>[0], dryRun = false) {
  return resetCommand(runtime, {
    scope: "config+creds+sessions",
    yes: true,
    nonInteractive: true,
    dryRun,
  });
}

function snapshotDatabase(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    const schema = db
      .prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    const tables = schema
      .filter((row) => row.type === "table")
      .map(({ name }) => {
        if (typeof name !== "string") {
          throw new Error("Expected a SQLite table name");
        }
        const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all();
        return { name, rows: rows.map((row) => sha256(JSON.stringify(row))).toSorted() };
      });
    return { schema, tables };
  } finally {
    db.close();
  }
}

async function snapshotFiles(root: string) {
  const entries = (await listDirectoryTreeStrict(root)).map((walkEntry) => walkEntry.dirent);
  return await Promise.all(
    entries
      // Read-only WAL access may create coordination sidecars without changing committed state.
      .filter((entry) => entry.isFile() && !/\.sqlite-(?:wal|shm)$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .toSorted((left, right) => left.localeCompare(right))
      .map(async (filename) => ({
        filename,
        value: filename.endsWith(".sqlite")
          ? snapshotDatabase(filename)
          : sha256(await fs.readFile(filename)),
      })),
  );
}

function archiveRow(kind: "published" | "pending") {
  const sessionId = `${kind}-archive-only`;
  const bytes = Buffer.from(JSON.stringify({ type: "session", id: sessionId }));
  return {
    session_id: sessionId,
    generation: kind,
    session_key: `agent:main:${kind}`,
    reason: "deleted" as const,
    encoding: "identity" as const,
    archive_blob: bytes,
    archive_sha256: sha256(bytes),
    archive_name: `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z`,
    created_at: 1,
    published_at: kind === "published" ? 1 : null,
  };
}

describe("reset canonical sessions", () => {
  it.each(["default", "custom"])(
    "previews and removes %s session history while preserving unrelated state",
    (store) =>
      withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
        const mainStore =
          store === "custom"
            ? state.path("custom", "sessions.sqlite")
            : sessionScope(state).storePath;
        const config = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          session: { store: mainStore },
        };
        await state.writeConfig(config);
        const workspaceFile = path.join(state.workspaceDir, "notes.md");
        await fs.writeFile(workspaceFile, "keep my workspace");
        const main = sessionScope(state, "main", mainStore);
        const scopes = [main, sessionScope(state, "retired")];
        const options = { agentId: "main", path: mainStore };
        for (const scope of scopes) {
          const question = {
            type: "message",
            id: "q",
            parentId: null,
            message: { role: "user", content: "keep" },
          };
          await seedTranscript(scope, `${scope.agentId}-session`, [question]);
          await waitForSessionTranscriptIndexReconcile({
            agentId: scope.agentId,
            path: scope.storePath,
          });
        }
        if (store === "default") {
          await seedTranscript(main, "embedded-session");
        }
        await seedTranscript(main, "current-session");
        await waitForSessionTranscriptIndexReconcile(options);
        let coldPath: string | undefined;
        let embeddedColdPath: string | undefined;
        if (store === "default") {
          writeSessions(options, (db) =>
            db
              .updateTable("session_windows")
              .set({ updated_at: 1, transcript_updated_at: 1 })
              .where("session_id", "in", ["main-session", "embedded-session"]),
          );
          await expect(
            runSessionColdStorageMaintenance({
              config: {
                ...config,
                session: {
                  ...config.session,
                  maintenance: { coldStorage: { enabled: true, afterDays: 30 } },
                },
              },
            }),
          ).resolves.toMatchObject({ archivedTranscripts: 2 });
          const database = openOpenClawAgentDatabase(options);
          const [cold, embedded] = ["main-session", "embedded-session"].map((id) =>
            readSessionColdTranscript(database.db, id),
          );
          expect([cold, embedded]).toMatchObject([{ storage: "file" }, { storage: "file" }]);
          coldPath = resolveSessionColdArchivePath(mainStore, cold!.archive_name);
          embeddedColdPath = resolveSessionColdArchivePath(mainStore, embedded!.archive_name);
          const embeddedBytes = await fs.readFile(embeddedColdPath);
          // Restored backups own embedded bytes, not a coincident file at the old archive path.
          writeSessions(options, (db) =>
            db
              .updateTable("session_transcript_cold_archives")
              .set({ storage: "sqlite", archive_blob: embeddedBytes })
              .where("session_id", "=", "embedded-session"),
          );
          await fs.writeFile(embeddedColdPath, "unrelated file beside a restored backup");
        }
        const archiveDirectory = resolveSessionArtifactDirectory(mainStore);
        const archives = [archiveRow("published"), archiveRow("pending")];
        writeSessions(options, (db) =>
          db.insertInto("session_transcript_archives").values(archives),
        );
        const publishedPath = path.join(archiveDirectory, archives[0]!.archive_name);
        await fs.writeFile(publishedPath, archives[0]!.archive_blob);
        const unrelatedPath = path.join(
          archiveDirectory,
          "unrelated.jsonl.deleted.2026-01-01T00-00-00.000Z",
        );
        await fs.writeFile(unrelatedPath, "another store owns this file");
        await state.writeAuthProfiles({
          version: 1,
          profiles: { test: { type: "api_key", provider: "test", key: "synthetic" } },
        });
        const authBefore = readPersistedAuthProfileStoreRaw(state.agentDir());
        for (const scope of [...scopes, sessionScope(state)]) {
          await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
        }
        const databaseIdentities = await Promise.all(
          scopes.map(async (scope) => {
            const { dev, ino } = await fs.stat(scope.storePath);
            return { scope, identity: { dev, ino } };
          }),
        );
        const before = await snapshotFiles(state.root);
        const { runtime, log, error } = silentRuntime();

        await reset(runtime, true);

        expect(await snapshotFiles(state.root)).toEqual(before);
        const preview = log.mock.calls.flat().join("\n");
        for (const scope of scopes) {
          expect(preview).toContain(scope.storePath);
          expect(preview).toContain(scope.sessionKey);
        }
        expect(preview).toContain(publishedPath);
        if (coldPath) {
          expect(preview).toContain(coldPath);
        }
        if (embeddedColdPath) {
          expect(preview).not.toContain(embeddedColdPath);
        }
        expect(preview).toContain(`${coldPath ? 4 : 2} retained archives`);
        expect(preview).not.toContain(unrelatedPath);

        await reset(runtime);
        await state.writeConfig(config);

        expect(error).not.toHaveBeenCalled();
        for (const { scope, identity } of databaseIdentities) {
          await expect(fs.stat(scope.storePath)).resolves.toMatchObject(identity);
          expect(loadSessionEntry(scope)).toBeUndefined();
          expect(listSessionTranscriptInstances(scope)).toEqual([]);
          expect(
            loadTranscriptEventsSync({ ...scope, sessionId: `${scope.agentId}-session` }),
          ).toEqual([]);
        }
        expect(loadTranscriptEventsSync({ ...main, sessionId: "current-session" })).toEqual([]);
        expect(
          listSessionTranscriptArchivesReadOnly({
            ...main,
            sessionIds: archives.map((archive) => archive.session_id),
          }),
        ).toEqual([]);
        await expectMissing(publishedPath, ...(coldPath ? [coldPath] : []));
        if (embeddedColdPath) {
          expect(
            readSessionColdTranscript(openOpenClawAgentDatabase(options).db, "embedded-session"),
          ).toBeUndefined();
          await expectFileText(embeddedColdPath, "unrelated file beside a restored backup");
        }
        expect(readPersistedAuthProfileStoreRaw(state.agentDir())).toEqual(authBefore);
        await expectFileText(workspaceFile, "keep my workspace");
        await expectFileText(unrelatedPath, "another store owns this file");
      }),
  );

  it("previews and resets a pre-archive store during onboarding with config and credentials absent", () =>
    withOpenClawTestState({ layout: "split" }, async (state) => {
      const scope = sessionScope(state);
      await replaceSessionEntry(scope, { sessionId: "onboard-session", updatedAt: Date.now() });
      const options = { agentId: "main", path: scope.storePath };
      const database = openOpenClawAgentDatabase(options);
      database.db.exec("DROP TABLE session_transcript_archives");
      assertOpenClawAgentCurrentRuntimeSchema(requireNativeSqliteDatabase(database.db), {
        agentId: "main",
        pathname: scope.storePath,
      });
      await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, "main");
      const before = await snapshotFiles(state.root);
      const { runtime } = silentRuntime();

      await reset(runtime, true);
      expect(await snapshotFiles(state.root)).toEqual(before);
      await handleReset("config+creds+sessions", state.workspaceDir, runtime);

      expect(loadSessionEntry(scope)).toBeUndefined();
      await fs.access(scope.storePath);
      await fs.access(state.workspaceDir);
    }));

  it("preserves a colliding archive's history while resetting other agents and independent paths", () =>
    withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
      const scope = sessionScope(state);
      const entry = { sessionId: "current-session", updatedAt: Date.now() };
      await replaceSessionEntry(scope, entry);
      const otherScope = sessionScope(state, "retired");
      await replaceSessionEntry(otherScope, { sessionId: "other-session", updatedAt: Date.now() });
      const archive = archiveRow("pending");
      writeSessions({ agentId: "main", path: scope.storePath }, (db) =>
        db.insertInto("session_transcript_archives").values(archive),
      );
      const collisionPath = path.join(state.sessionsDir(), archive.archive_name);
      await fs.mkdir(state.sessionsDir(), { recursive: true });
      await fs.writeFile(collisionPath, "unrelated file prevented archive publication");
      const before = snapshotDatabase(scope.storePath);
      const credentialsPath = await state.writeText("credentials/fixture", "synthetic");
      const { runtime, log, error } = silentRuntime();

      await expect(reset(runtime)).rejects.toMatchObject({ name: "ExitError", code: 1 });

      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/archive.*ownership|ownership.*archive/i),
      );
      expect(error).toHaveBeenLastCalledWith(
        "Reset incomplete. Resolve the cleanup errors above, then retry reset.",
      );
      expect(log.mock.calls.flat().join("\n")).not.toMatch(/^Next:/m);
      expect(snapshotDatabase(scope.storePath)).toEqual(before);
      expect(loadSessionEntry(scope)).toMatchObject(entry);
      expect(loadSessionEntry(otherScope)).toBeUndefined();
      await expectFileText(collisionPath, "unrelated file prevented archive publication");
      await expectMissing(state.configPath, path.dirname(credentialsPath));
    }));
});
