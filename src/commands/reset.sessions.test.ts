import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPersistedAuthProfileStoreRaw } from "../agents/auth-profiles/sqlite.js";
import { resolveSessionArtifactDirectory } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionTranscriptArchivesReadOnly } from "../config/sessions/session-accessor.sqlite-history.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSessionColdArchivePath } from "../config/sessions/session-cold-storage-codec.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import { listSessionTranscriptInstances } from "../config/sessions/session-history.js";
import { waitForSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { createNonExitingRuntime } from "../runtime.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "../state/openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleReset } from "./onboard-helpers.js";
import { resetCommand } from "./reset.js";

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ isLoaded: async () => false }),
}));

afterEach(() => vi.restoreAllMocks());

function silentRuntime() {
  const runtime = createNonExitingRuntime();
  const log = vi.spyOn(runtime, "log").mockImplementation(() => {});
  const error = vi.spyOn(runtime, "error").mockImplementation(() => {});
  return { runtime, log, error };
}

function sha256(bytes: string | Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function snapshotDatabase(filename: string) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    expect(integrity).toEqual([{ integrity_check: "ok" }]);
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
    return { integrity, schema, tables };
  } finally {
    db.close();
  }
}

async function snapshotFiles(root: string) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return await Promise.all(
    entries
      // Read-only WAL access may create coordination sidecars without changing committed state.
      .filter((entry) => entry.isFile() && !/\.sqlite-(?:wal|shm)$/.test(entry.name))
      .toSorted((left, right) =>
        path
          .join(left.parentPath, left.name)
          .localeCompare(path.join(right.parentPath, right.name)),
      )
      .map(async (entry) => {
        const filename = path.join(entry.parentPath, entry.name);
        return {
          filename,
          value: filename.endsWith(".sqlite")
            ? snapshotDatabase(filename)
            : sha256(await fs.readFile(filename)),
        };
      }),
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
    async (store) => {
      await withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
        const mainStore =
          store === "custom"
            ? state.path("custom", "sessions.sqlite")
            : path.join(state.agentDir(), "openclaw-agent.sqlite");
        const config = {
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          session: { store: mainStore },
        };
        await state.writeConfig(config);
        const workspaceFile = path.join(state.workspaceDir, "notes.md");
        await fs.writeFile(workspaceFile, "keep my workspace");
        const scopes = [
          { agentId: "main", sessionKey: "agent:main:chat", storePath: mainStore },
          {
            agentId: "retired",
            sessionKey: "agent:retired:chat",
            storePath: path.join(state.agentDir("retired"), "openclaw-agent.sqlite"),
          },
        ];
        const main = scopes[0]!;
        const options = { agentId: "main", path: mainStore };
        for (const scope of scopes) {
          await replaceSessionEntry(scope, {
            sessionId: `${scope.agentId}-session`,
            updatedAt: Date.now(),
          });
          await replaceTranscriptEvents({ ...scope, sessionId: `${scope.agentId}-session` }, [
            { type: "session", id: `${scope.agentId}-session`, version: 3 },
            {
              type: "message",
              id: "question",
              parentId: null,
              message: { role: "user", content: "Remember this conversation" },
            },
          ]);
          await waitForSessionTranscriptIndexReconcile({
            agentId: scope.agentId,
            path: scope.storePath,
          });
        }
        if (store === "default") {
          await replaceSessionEntry(main, { sessionId: "embedded-session", updatedAt: Date.now() });
          await replaceTranscriptEvents({ ...main, sessionId: "embedded-session" }, [
            { type: "session", id: "embedded-session", version: 3 },
          ]);
        }
        await replaceSessionEntry(main, { sessionId: "current-session", updatedAt: Date.now() });
        await replaceTranscriptEvents({ ...main, sessionId: "current-session" }, [
          { type: "session", id: "current-session", version: 3 },
        ]);
        await waitForSessionTranscriptIndexReconcile(options);
        let coldPath: string | undefined;
        let embeddedColdPath: string | undefined;
        if (store === "default") {
          runOpenClawAgentWriteTransaction(({ db }) => {
            executeSqliteQuerySync(
              db,
              getSessionKysely(db)
                .updateTable("session_windows")
                .set({ updated_at: 1, transcript_updated_at: 1 })
                .where("session_id", "in", ["main-session", "embedded-session"]),
            );
          }, options);
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
          const cold = readSessionColdTranscript(database.db, "main-session");
          expect(cold?.storage).toBe("file");
          coldPath = resolveSessionColdArchivePath(mainStore, cold!.archive_name);
          const embedded = readSessionColdTranscript(database.db, "embedded-session");
          if (!embedded || embedded.storage !== "file") {
            throw new Error("Expected the second historical generation in cold storage");
          }
          embeddedColdPath = resolveSessionColdArchivePath(mainStore, embedded.archive_name);
          const embeddedBytes = await fs.readFile(embeddedColdPath);
          // Restored backups own embedded bytes, not a coincident file at the old archive path.
          runOpenClawAgentWriteTransaction(({ db }) => {
            executeSqliteQuerySync(
              db,
              getSessionKysely(db)
                .updateTable("session_transcript_cold_archives")
                .set({ storage: "sqlite", archive_blob: embeddedBytes })
                .where("session_id", "=", "embedded-session"),
            );
          }, options);
          await fs.writeFile(embeddedColdPath, "unrelated file beside a restored backup");
        }
        const archiveDirectory = resolveSessionArtifactDirectory(mainStore);
        const archives = [archiveRow("published"), archiveRow("pending")];
        runOpenClawAgentWriteTransaction(({ db }) => {
          executeSqliteQuerySync(
            db,
            getSessionKysely(db).insertInto("session_transcript_archives").values(archives),
          );
        }, options);
        const publishedPath = path.join(archiveDirectory, archives[0]!.archive_name);
        await fs.writeFile(publishedPath, archives[0]!.archive_blob);
        const unrelatedPath = path.join(
          archiveDirectory,
          "unrelated.jsonl.deleted.2026-01-01T00-00-00.000Z",
        );
        await fs.writeFile(unrelatedPath, "another store owns this file");
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "test:default": {
              type: "api_key",
              provider: "test",
              key: "synthetic-reset-credential",
            },
          },
        });
        const authBefore = readPersistedAuthProfileStoreRaw(state.agentDir());
        for (const scope of scopes) {
          await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, scope.agentId);
        }
        await closeOpenClawAgentDatabaseByPathAsync(
          path.join(state.agentDir(), "openclaw-agent.sqlite"),
          "main",
        );
        const databaseIdentities = await Promise.all(
          scopes.map(async (scope) => {
            const { dev, ino } = await fs.stat(scope.storePath);
            return { scope, identity: { dev, ino } };
          }),
        );
        const before = await snapshotFiles(state.root);
        const { runtime, log, error } = silentRuntime();

        await resetCommand(runtime, {
          scope: "config+creds+sessions",
          yes: true,
          nonInteractive: true,
          dryRun: true,
        });

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

        await resetCommand(runtime, {
          scope: "config+creds+sessions",
          yes: true,
          nonInteractive: true,
        });
        await state.writeConfig(config);

        expect(error).not.toHaveBeenCalled();
        for (const { scope, identity } of databaseIdentities) {
          await expect(fs.stat(scope.storePath)).resolves.toMatchObject(identity);
          expect(loadSessionEntry(scope)).toBeUndefined();
          expect(listSessionTranscriptInstances(scope)).toEqual([]);
          expect(
            loadTranscriptEventsSync({ ...scope, sessionId: `${scope.agentId}-session` }),
          ).toEqual([]);
          await expect(fs.access(scope.storePath)).resolves.toBeUndefined();
        }
        expect(loadTranscriptEventsSync({ ...main, sessionId: "current-session" })).toEqual([]);
        expect(
          listSessionTranscriptArchivesReadOnly({
            ...main,
            sessionIds: archives.map((archive) => archive.session_id),
          }),
        ).toEqual([]);
        await expect(fs.access(publishedPath)).rejects.toMatchObject({ code: "ENOENT" });
        if (coldPath) {
          await expect(fs.access(coldPath)).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (embeddedColdPath) {
          expect(
            readSessionColdTranscript(openOpenClawAgentDatabase(options).db, "embedded-session"),
          ).toBeUndefined();
          await expect(fs.readFile(embeddedColdPath, "utf8")).resolves.toBe(
            "unrelated file beside a restored backup",
          );
        }
        expect(readPersistedAuthProfileStoreRaw(state.agentDir())).toEqual(authBefore);
        await expect(fs.readFile(workspaceFile, "utf8")).resolves.toBe("keep my workspace");
        await expect(fs.readFile(unrelatedPath, "utf8")).resolves.toBe(
          "another store owns this file",
        );
      });
    },
  );

  it("previews and resets a pre-archive store during onboarding with config and credentials absent", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:chat",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(scope, { sessionId: "onboard-session", updatedAt: Date.now() });
      const options = { agentId: "main", path: scope.storePath };
      const database = openOpenClawAgentDatabase(options);
      database.db.exec("DROP TABLE session_transcript_archives");
      assertOpenClawAgentCurrentRuntimeSchema(database.db, {
        agentId: "main",
        pathname: scope.storePath,
      });
      await closeOpenClawAgentDatabaseByPathAsync(scope.storePath, "main");
      const before = await snapshotFiles(state.root);
      const { runtime } = silentRuntime();

      await resetCommand(runtime, {
        scope: "config+creds+sessions",
        yes: true,
        nonInteractive: true,
        dryRun: true,
      });
      expect(await snapshotFiles(state.root)).toEqual(before);
      await handleReset("config+creds+sessions", state.workspaceDir, runtime);

      expect(loadSessionEntry(scope)).toBeUndefined();
      await expect(fs.access(scope.storePath)).resolves.toBeUndefined();
      await expect(fs.access(state.workspaceDir)).resolves.toBeUndefined();
    });
  });

  it("preserves a colliding archive's history while resetting other agents and independent paths", async () => {
    await withOpenClawTestState({ layout: "split", scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:chat",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const entry = { sessionId: "current-session", updatedAt: Date.now() };
      await replaceSessionEntry(scope, entry);
      const otherScope = {
        agentId: "retired",
        sessionKey: "agent:retired:chat",
        storePath: path.join(state.agentDir("retired"), "openclaw-agent.sqlite"),
      };
      await replaceSessionEntry(otherScope, { sessionId: "other-session", updatedAt: Date.now() });
      const archive = archiveRow("pending");
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getSessionKysely(db).insertInto("session_transcript_archives").values(archive),
          );
        },
        { agentId: "main", path: scope.storePath },
      );
      const collisionPath = path.join(state.sessionsDir(), archive.archive_name);
      await fs.mkdir(state.sessionsDir(), { recursive: true });
      await fs.writeFile(collisionPath, "unrelated file prevented archive publication");
      const before = snapshotDatabase(scope.storePath);
      const credentialsDir = path.join(state.stateDir, "credentials");
      await fs.mkdir(credentialsDir, { recursive: true });
      await fs.writeFile(path.join(credentialsDir, "fixture"), "synthetic credential state");
      const { runtime, log, error } = silentRuntime();

      await expect(
        resetCommand(runtime, { scope: "config+creds+sessions", yes: true, nonInteractive: true }),
      ).rejects.toMatchObject({ name: "ExitError", code: 1 });

      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/archive.*ownership|ownership.*archive/i),
      );
      expect(error).toHaveBeenLastCalledWith(
        "Reset incomplete. Resolve the cleanup errors above, then retry reset.",
      );
      expect(log.mock.calls.flat().some((message) => String(message).startsWith("Next:"))).toBe(
        false,
      );
      expect(snapshotDatabase(scope.storePath)).toEqual(before);
      expect(loadSessionEntry(scope)).toMatchObject(entry);
      expect(loadSessionEntry(otherScope)).toBeUndefined();
      await expect(fs.readFile(collisionPath, "utf8")).resolves.toBe(
        "unrelated file prevented archive publication",
      );
      await expect(fs.access(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(credentialsDir)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
