import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  cleanupSessionLifecycleArtifacts,
  listSessionEntries,
  loadExactSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry,
  publishTranscriptUpdate,
  readSessionUpdatedAt,
  replaceSessionEntry,
  updateSessionEntry,
  upsertSessionEntry,
  type ExactSessionEntry,
  type SessionAccessScope,
  type SessionEntrySummary,
  type SessionTranscriptAccessScope,
  type SessionTranscriptReadScope,
  type SessionTranscriptWriteScope,
  type TranscriptEvent,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
  type TranscriptUpdatePayload,
} from "./session-accessor.js";
import {
  appendSqliteTranscriptEvent,
  appendSqliteTranscriptMessage,
  cleanupSqliteSessionLifecycleArtifacts,
  listSqliteSessionEntries,
  loadExactSqliteSessionEntry,
  loadSqliteSessionEntry,
  loadSqliteTranscriptEvents,
  loadSqliteTranscriptEventsSync,
  patchSqliteSessionEntry,
  publishSqliteTranscriptUpdate,
  readSqliteSessionUpdatedAt,
  replaceSqliteSessionEntry,
  updateSqliteSessionEntry,
  upsertSqliteSessionEntry,
} from "./session-accessor.sqlite.js";
import type { SessionEntry } from "./types.js";

type AccessorAdapter = {
  name: string;
  publishesTranscriptUpdates: boolean;
  entryScope(paths: TestPaths): SessionAccessScope;
  transcriptReadScope(paths: TestPaths, id?: string): SessionTranscriptReadScope;
  transcriptScope(paths: TestPaths, id?: string): SessionTranscriptAccessScope;
  loadExactSessionEntry(scope: SessionAccessScope): ExactSessionEntry | undefined;
  loadSessionEntry(scope: SessionAccessScope): SessionEntry | undefined;
  listSessionEntries(scope: Partial<Omit<SessionAccessScope, "sessionKey">>): SessionEntrySummary[];
  readSessionUpdatedAt(scope: SessionAccessScope): number | undefined;
  upsertSessionEntry(
    scope: SessionAccessScope,
    patch: Partial<SessionEntry>,
  ): Promise<SessionEntry | null>;
  replaceSessionEntry(scope: SessionAccessScope, entry: SessionEntry): Promise<SessionEntry | null>;
  patchSessionEntry(
    scope: SessionAccessScope,
    update: (
      entry: SessionEntry,
      context: { existingEntry?: SessionEntry },
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null,
    options?: { fallbackEntry?: SessionEntry; preserveActivity?: boolean; replaceEntry?: boolean },
  ): Promise<SessionEntry | null>;
  updateSessionEntry(
    scope: SessionAccessScope,
    update: (entry: SessionEntry) => Partial<SessionEntry> | null,
  ): Promise<SessionEntry | null>;
  cleanupSessionLifecycleArtifacts(params: {
    storePath: string;
    sessionKeySegmentPrefix: string;
    transcriptContentMarker: string;
    orphanTranscriptMinAgeMs: number;
    nowMs?: number;
  }): Promise<{ removedEntries: number; archivedTranscriptArtifacts: number }>;
  loadTranscriptEvents(scope: SessionTranscriptReadScope): Promise<TranscriptEvent[]>;
  appendTranscriptEvent(scope: SessionTranscriptAccessScope, event: TranscriptEvent): Promise<void>;
  appendTranscriptMessage<TMessage>(
    scope: SessionTranscriptWriteScope,
    options: TranscriptMessageAppendOptions<TMessage>,
  ): Promise<TranscriptMessageAppendResult<TMessage> | undefined>;
  publishTranscriptUpdate(
    scope: SessionTranscriptWriteScope,
    update?: TranscriptUpdatePayload,
  ): Promise<void>;
};

type TestPaths = {
  sqlitePath: string;
  stateDir: string;
  storePath: string;
  tempDir: string;
  transcriptPath: string;
};

const fileBackedAdapter: AccessorAdapter = {
  name: "file-backed",
  publishesTranscriptUpdates: true,
  entryScope: (paths) => ({
    sessionKey: "agent:main:main",
    storePath: paths.storePath,
  }),
  transcriptScope: (paths, id = "session-1") => ({
    sessionFile: paths.transcriptPath,
    sessionId: id,
    sessionKey: "agent:main:main",
    storePath: paths.storePath,
  }),
  transcriptReadScope: (paths, id = "session-1") => ({
    sessionFile: paths.transcriptPath,
    sessionId: id,
    storePath: paths.storePath,
  }),
  loadSessionEntry,
  loadExactSessionEntry,
  listSessionEntries,
  readSessionUpdatedAt,
  upsertSessionEntry,
  replaceSessionEntry,
  patchSessionEntry,
  updateSessionEntry,
  cleanupSessionLifecycleArtifacts,
  loadTranscriptEvents,
  appendTranscriptEvent,
  appendTranscriptMessage,
  publishTranscriptUpdate,
};

const sqliteAdapter: AccessorAdapter = {
  name: "sqlite",
  publishesTranscriptUpdates: false,
  entryScope: (paths) => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    sessionKey: "agent:main:main",
    storePath: paths.sqlitePath,
  }),
  transcriptReadScope: (paths, id = "session-1") => ({
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
    sessionId: id,
    storePath: paths.sqlitePath,
  }),
  loadSessionEntry: loadSqliteSessionEntry,
  loadExactSessionEntry: loadExactSqliteSessionEntry,
  listSessionEntries: listSqliteSessionEntries,
  readSessionUpdatedAt: readSqliteSessionUpdatedAt,
  upsertSessionEntry: upsertSqliteSessionEntry,
  replaceSessionEntry: replaceSqliteSessionEntry,
  patchSessionEntry: patchSqliteSessionEntry,
  updateSessionEntry: updateSqliteSessionEntry,
  cleanupSessionLifecycleArtifacts: cleanupSqliteSessionLifecycleArtifacts,
  loadTranscriptEvents: loadSqliteTranscriptEvents,
  appendTranscriptEvent: appendSqliteTranscriptEvent,
  appendTranscriptMessage: appendSqliteTranscriptMessage,
  publishTranscriptUpdate: publishSqliteTranscriptUpdate,
};

describe.each([fileBackedAdapter, sqliteAdapter])(
  "session accessor conformance: $name",
  (adapter) => {
    let paths: TestPaths;

    beforeEach(() => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-accessor-conf-"));
      paths = {
        sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
        stateDir: path.join(tempDir, "state"),
        storePath: path.join(tempDir, "sessions.json"),
        tempDir,
        transcriptPath: path.join(tempDir, "session.jsonl"),
      };
    });

    afterEach(() => {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(paths.tempDir, { recursive: true, force: true });
    });

    it("conforms for entry load/list/timestamp/upsert/update/replace/patch", async () => {
      const scope = adapter.entryScope(paths);

      await adapter.upsertSessionEntry(scope, {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      });

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: expect.any(Number),
      });
      expect(adapter.readSessionUpdatedAt(scope)).toEqual(expect.any(Number));
      expect(adapter.listSessionEntries(scope)).toEqual([
        {
          sessionKey: "agent:main:main",
          entry: expect.objectContaining({
            model: "gpt-5.5",
            sessionId: "session-1",
          }),
        },
      ]);

      await expect(
        adapter.updateSessionEntry(scope, () => ({ model: "sonnet-4.6", updatedAt: 20 })),
      ).resolves.toMatchObject({
        model: "sonnet-4.6",
        sessionId: "session-1",
      });

      await adapter.replaceSessionEntry(scope, {
        providerOverride: "openai",
        sessionId: "session-1",
        updatedAt: 30,
      });

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        providerOverride: "openai",
        sessionId: "session-1",
      });
      expect(adapter.loadSessionEntry(scope)?.model).toBeUndefined();

      let existingContext: SessionEntry | undefined;
      await adapter.patchSessionEntry(
        scope,
        (entry, context) => {
          existingContext = context.existingEntry;
          return {
            ...entry,
            model: "gpt-5.5",
          };
        },
        { replaceEntry: true },
      );

      expect(existingContext).toMatchObject({ providerOverride: "openai" });
      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
      });

      const beforePreservePatch = adapter.loadSessionEntry(scope);
      await adapter.patchSessionEntry(
        scope,
        () => ({
          providerOverride: "anthropic",
          updatedAt: 40,
        }),
        { preserveActivity: true },
      );

      expect(adapter.loadSessionEntry(scope)).toMatchObject({
        model: "gpt-5.5",
        providerOverride: "anthropic",
        sessionId: "session-1",
        updatedAt: beforePreservePatch?.updatedAt,
      });
    });

    it("conforms for exact persisted-key lookup without canonical alias fallback", async () => {
      const scope = adapter.entryScope(paths);
      const mixedCaseScope = { ...scope, sessionKey: "AGENT:MAIN:MAIN" };

      await adapter.upsertSessionEntry(scope, {
        model: "gpt-5.5",
        sessionId: "exact-session",
        updatedAt: 10,
      });

      expect(adapter.loadSessionEntry(mixedCaseScope)).toMatchObject({
        model: "gpt-5.5",
        sessionId: "exact-session",
      });
      expect(adapter.loadExactSessionEntry(mixedCaseScope)).toBeUndefined();
      expect(adapter.loadExactSessionEntry(scope)).toEqual({
        sessionKey: "agent:main:main",
        entry: expect.objectContaining({
          model: "gpt-5.5",
          sessionId: "exact-session",
        }),
      });
    });

    it("conforms for lifecycle entry and transcript cleanup", async () => {
      const nowMs = Date.now();
      const oldTimestamp = nowMs - 600_000;
      const cleanupStorePath =
        adapter.name === "sqlite"
          ? path.join(paths.stateDir, "agents", "main", "sessions", "sessions.json")
          : paths.storePath;
      const scopedEntry = (sessionKey: string): SessionAccessScope => ({
        ...adapter.entryScope(paths),
        sessionKey,
        storePath: cleanupStorePath,
      });
      const scopedTranscript = (
        sessionKey: string,
        sessionId: string,
      ): SessionTranscriptAccessScope => ({
        ...adapter.transcriptScope(paths, sessionId),
        sessionKey,
        storePath: cleanupStorePath,
      });
      const writeTranscript = async (params: {
        sessionKey: string;
        sessionId: string;
        old?: boolean;
      }) => {
        const timestamp = params.old ? oldTimestamp : nowMs;
        const event = {
          id: `${params.sessionId}-event`,
          marker: "lifecycle-marker-run",
          timestamp: new Date(timestamp).toISOString(),
          type: "metadata",
        };
        if (adapter.name === "sqlite") {
          await adapter.appendTranscriptEvent(
            scopedTranscript(params.sessionKey, params.sessionId),
            event,
          );
          return;
        }
        const transcriptPath = path.join(
          path.dirname(cleanupStorePath),
          `${params.sessionId}.jsonl`,
        );
        fs.writeFileSync(transcriptPath, `${JSON.stringify(event)}\n`, "utf-8");
        if (params.old) {
          const oldDate = new Date(oldTimestamp);
          fs.utimesSync(transcriptPath, oldDate, oldDate);
        }
      };

      await adapter.upsertSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-missing"), {
        sessionId: "missing-lifecycle",
        updatedAt: oldTimestamp,
      });
      await adapter.upsertSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-removed"), {
        sessionId: "removed-lifecycle",
        updatedAt: oldTimestamp,
      });
      await adapter.upsertSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-fresh"), {
        sessionId: "fresh-lifecycle",
        updatedAt: nowMs,
      });
      await adapter.upsertSessionEntry(
        scopedEntry("agent:main:telegram:group:lifecycle-cleanup-room"),
        {
          sessionId: "kept-by-segment",
          updatedAt: oldTimestamp,
        },
      );
      await adapter.upsertSessionEntry(scopedEntry("agent:main:regular"), {
        sessionId: "referenced",
        updatedAt: oldTimestamp,
      });
      await writeTranscript({
        sessionKey: "agent:main:lifecycle-cleanup-removed",
        sessionId: "removed-lifecycle",
        old: true,
      });
      await writeTranscript({
        sessionKey: "agent:main:lifecycle-cleanup-fresh",
        sessionId: "fresh-lifecycle",
      });
      await writeTranscript({
        sessionKey: "agent:main:regular",
        sessionId: "referenced",
        old: true,
      });
      await writeTranscript({
        sessionKey: "agent:main:orphan",
        sessionId: "orphan-lifecycle",
        old: true,
      });

      await expect(
        adapter.cleanupSessionLifecycleArtifacts({
          storePath: cleanupStorePath,
          sessionKeySegmentPrefix: "lifecycle-cleanup-",
          transcriptContentMarker: "lifecycle-marker-",
          orphanTranscriptMinAgeMs: 300_000,
          nowMs,
        }),
      ).resolves.toEqual({ removedEntries: 2, archivedTranscriptArtifacts: 2 });

      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-missing")),
      ).toBeUndefined();
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-removed")),
      ).toBeUndefined();
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:lifecycle-cleanup-fresh")),
      ).toMatchObject({
        sessionId: "fresh-lifecycle",
      });
      expect(
        adapter.loadSessionEntry(scopedEntry("agent:main:telegram:group:lifecycle-cleanup-room")),
      ).toMatchObject({ sessionId: "kept-by-segment" });
      expect(adapter.loadSessionEntry(scopedEntry("agent:main:regular"))).toMatchObject({
        sessionId: "referenced",
      });
      if (adapter.name === "sqlite") {
        expect(fs.existsSync(cleanupStorePath)).toBe(false);
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
          path: path.join(paths.stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"),
        });
        const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
        const removedRoute = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_routes")
            .select("session_id")
            .where("session_key", "=", "agent:main:lifecycle-cleanup-removed"),
        );
        expect(removedRoute).toBeUndefined();
        const freshRoute = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_routes")
            .select("session_id")
            .where("session_key", "=", "agent:main:lifecycle-cleanup-fresh"),
        );
        expect(freshRoute).toEqual({ session_id: "fresh-lifecycle" });
        await expect(
          adapter.loadTranscriptEvents(scopedTranscript("agent:main:regular", "referenced")),
        ).resolves.not.toEqual([]);
        await expect(
          adapter.loadTranscriptEvents(
            scopedTranscript("agent:main:lifecycle-cleanup-removed", "removed-lifecycle"),
          ),
        ).resolves.toEqual([]);
      } else {
        const files = fs.readdirSync(path.dirname(cleanupStorePath));
        expect(
          files.filter((file) => file.startsWith("removed-lifecycle.jsonl.deleted.")),
        ).toHaveLength(1);
        expect(
          files.filter((file) => file.startsWith("orphan-lifecycle.jsonl.deleted.")),
        ).toHaveLength(1);
        expect(files).toContain("fresh-lifecycle.jsonl");
        expect(files).toContain("referenced.jsonl");
      }
    });

    it("conforms for raw transcript event load and append", async () => {
      const scope = adapter.transcriptScope(paths);
      const readScope = adapter.transcriptReadScope(paths);
      const event = {
        id: "event-1",
        parentId: null,
        payload: { content: "hello" },
        type: "metadata",
      };

      await adapter.appendTranscriptEvent(scope, { type: "session", sessionId: "session-1" });
      await adapter.appendTranscriptEvent(scope, event);

      await expect(adapter.loadTranscriptEvents(readScope)).resolves.toEqual([
        { type: "session", sessionId: "session-1" },
        event,
      ]);
    });

    it("loads raw SQLite transcript events synchronously through a read scope", async () => {
      const scope = sqliteAdapter.transcriptScope(paths);
      const readScope = sqliteAdapter.transcriptReadScope(paths);
      const event = {
        id: "event-1",
        parentId: null,
        payload: { content: "hello" },
        type: "metadata",
      };

      await sqliteAdapter.appendTranscriptEvent(scope, event);

      expect(loadSqliteTranscriptEventsSync(readScope)).toEqual([event]);
    });

    it("maps canonical sessions.json store paths to the agent SQLite database", async () => {
      const legacyStorePath = path.join(
        paths.stateDir,
        "agents",
        "voice",
        "sessions",
        "sessions.json",
      );
      const sqlitePath = path.join(
        paths.stateDir,
        "agents",
        "voice",
        "agent",
        "openclaw-agent.sqlite",
      );
      const scope = {
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: "voice:123",
        storePath: legacyStorePath,
      };

      await upsertSqliteSessionEntry(scope, {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      });

      expect(
        loadSqliteSessionEntry({ ...scope, agentId: "voice", storePath: sqlitePath }),
      ).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
      });
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(fs.existsSync(legacyStorePath)).toBe(false);
      expect(
        listSqliteSessionEntries({
          env: scope.env,
          storePath: sqlitePath,
        }),
      ).toEqual([
        expect.objectContaining({
          entry: expect.objectContaining({ sessionId: "session-1" }),
          sessionKey: "voice:123",
        }),
      ]);
      expect(() =>
        loadSqliteSessionEntry({ ...scope, agentId: "main", storePath: sqlitePath }),
      ).toThrow("belongs to agent voice; requested agent main");
    });

    it("does not treat custom JSON store paths as SQLite database files", async () => {
      const customStorePath = path.join(paths.tempDir, "custom-sessions.json");
      const sqlitePath = path.join(
        paths.stateDir,
        "agents",
        "voice",
        "agent",
        "openclaw-agent.sqlite",
      );
      const scope = {
        env: { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir },
        sessionKey: "agent:voice:main",
        storePath: customStorePath,
      };

      await upsertSqliteSessionEntry(scope, {
        model: "gpt-5.5",
        sessionId: "session-1",
        updatedAt: 10,
      });

      expect(
        loadSqliteSessionEntry({ ...scope, agentId: "voice", storePath: sqlitePath }),
      ).toMatchObject({
        model: "gpt-5.5",
        sessionId: "session-1",
      });
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(fs.existsSync(customStorePath)).toBe(false);
    });

    it("serializes concurrent SQLite entry patches and updates", async () => {
      const scope = sqliteAdapter.entryScope(paths);

      await upsertSqliteSessionEntry(scope, {
        model: "base",
        sessionId: "patch-session",
        updatedAt: 10,
      });

      let firstPatch!: Promise<SessionEntry | null>;
      let releasePatch!: () => void;
      const patchStarted = new Promise<void>((resolve) => {
        const blockedPatch = new Promise<void>((release) => {
          releasePatch = release;
        });
        firstPatch = patchSqliteSessionEntry(scope, async () => {
          resolve();
          await blockedPatch;
          return { model: "first" };
        });
      });
      await patchStarted;
      const secondPatch = patchSqliteSessionEntry(scope, () => ({
        providerOverride: "openai",
      }));
      releasePatch();
      await Promise.all([firstPatch, secondPatch]);

      expect(loadSqliteSessionEntry(scope)).toMatchObject({
        model: "first",
        providerOverride: "openai",
      });

      let firstUpdate!: Promise<SessionEntry | null>;
      let releaseUpdate!: () => void;
      const updateStarted = new Promise<void>((resolve) => {
        const blockedUpdate = new Promise<void>((release) => {
          releaseUpdate = release;
        });
        firstUpdate = updateSqliteSessionEntry(scope, async () => {
          resolve();
          await blockedUpdate;
          return { model: "updated" };
        });
      });
      await updateStarted;
      const secondUpdate = updateSqliteSessionEntry(scope, () => ({
        providerOverride: "anthropic",
      }));
      releaseUpdate();
      await Promise.all([firstUpdate, secondUpdate]);

      expect(loadSqliteSessionEntry(scope)).toMatchObject({
        model: "updated",
        providerOverride: "anthropic",
      });
    });

    it("dedupes SQLite transcript identities inside the writer path", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-dedupe");
      const event = {
        id: "event-dedupe",
        source: "conformance",
        type: "metadata",
      };

      await appendSqliteTranscriptEvent(scope, event);
      await appendSqliteTranscriptEvent(scope, {
        ...event,
        message: { role: "assistant", content: "duplicate" },
      });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          appendSqliteTranscriptMessage(scope, {
            idempotencyLookup: "scan",
            message: {
              role: "assistant",
              content: "keyed",
              idempotencyKey: "keyed-once",
            },
          }),
        ),
      );

      expect(new Set(results.map((result) => result?.messageId)).size).toBe(1);
      expect(results.filter((result) => result?.appended)).toHaveLength(1);
      await expect(loadSqliteTranscriptEvents(scope)).resolves.toEqual([
        event,
        expect.objectContaining({
          message: expect.objectContaining({ idempotencyKey: "keyed-once" }),
          type: "message",
        }),
      ]);
    });

    it("rejects raw message transcript event writes", async () => {
      const scope = adapter.transcriptScope(paths, "session-raw-message");
      await expect(
        adapter.appendTranscriptEvent(scope, {
          id: "raw-message",
          message: { role: "assistant", content: "raw" },
          parentId: null,
          type: "message",
        }),
      ).rejects.toThrow(/use append(?:Sqlite)?TranscriptMessage instead/);
    });

    it("does not report success for unchecked duplicate SQLite transcript keys", async () => {
      const scope = sqliteAdapter.transcriptScope(paths, "session-unchecked-dedupe");
      const message = {
        role: "assistant",
        content: "unchecked",
        idempotencyKey: "unchecked-once",
      };

      await appendSqliteTranscriptMessage(scope, { message });
      await expect(appendSqliteTranscriptMessage(scope, { message })).rejects.toThrow();

      const events = await loadSqliteTranscriptEvents(scope);
      const keyedEvents = events.filter((event): event is { message: typeof message } => {
        return (
          Boolean(event) &&
          typeof event === "object" &&
          !Array.isArray(event) &&
          (event as { message?: { idempotencyKey?: string } }).message?.idempotencyKey ===
            "unchecked-once"
        );
      });
      expect(keyedEvents).toHaveLength(1);
    });

    it("conforms for transcript message append, idempotency, and update publication", async () => {
      const scope = adapter.transcriptScope(paths, "session-2");
      const updates: unknown[] = [];
      const unsubscribe = onSessionTranscriptUpdate((update) => {
        updates.push(update);
      });

      const appended = await adapter.appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: "hello",
          idempotencyKey: "assistant-once",
        },
      });
      const replayed = await adapter.appendTranscriptMessage(scope, {
        cwd: paths.tempDir,
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: "hello again",
          idempotencyKey: "assistant-once",
        },
      });
      await adapter.publishTranscriptUpdate(scope, {
        agentId: "main",
        message: appended?.message,
        messageId: appended?.messageId,
        sessionKey: scope.sessionKey,
      });
      unsubscribe();

      expect(appended).toMatchObject({
        appended: true,
        message: expect.objectContaining({ content: "hello" }),
        messageId: expect.any(String),
      });
      expect(replayed).toMatchObject({
        appended: false,
        message: expect.objectContaining({
          content: "hello",
          idempotencyKey: "assistant-once",
        }),
        messageId: appended?.messageId,
      });
      await expect(adapter.loadTranscriptEvents(scope)).resolves.toEqual([
        expect.objectContaining({ type: "session" }),
        expect.objectContaining({
          id: appended?.messageId,
          message: expect.objectContaining({ content: "hello" }),
          type: "message",
        }),
      ]);
      if (adapter.publishesTranscriptUpdates) {
        expect(updates).toEqual([
          expect.objectContaining({
            agentId: "main",
            message: appended?.message,
            messageId: appended?.messageId,
            sessionKey: scope.sessionKey,
          }),
        ]);
      } else {
        expect(updates).toEqual([]);
      }
    });
  },
);

describe("sqlite session normalization", () => {
  let paths: TestPaths;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-sqlite-norm-"));
    paths = {
      sqlitePath: path.join(tempDir, "openclaw-agent.sqlite"),
      stateDir: path.join(tempDir, "state"),
      storePath: path.join(tempDir, "sessions.json"),
      tempDir,
      transcriptPath: path.join(tempDir, "session.jsonl"),
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(paths.tempDir, { recursive: true, force: true });
  });

  it("maintains normalized session root and route rows", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env,
        sessionKey: "agent:main:group:example",
        storePath: paths.sqlitePath,
      },
      {
        agentHarnessId: "codex",
        chatType: "group",
        channel: "discord",
        deliveryContext: {
          accountId: "acct-1",
          channel: "discord",
          threadId: "thread-1",
          to: "group-1",
        },
        displayName: "Example group",
        endedAt: 90,
        model: "gpt-5.5",
        modelProvider: "openai",
        parentSessionKey: "agent:main:parent",
        sessionId: "normalized-session",
        sessionStartedAt: 50,
        spawnedBy: "agent:main:spawner",
        startedAt: 60,
        status: "done",
        updatedAt: 100,
      },
    );

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: paths.sqlitePath,
    });
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const session = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("sessions")
        .select([
          "account_id",
          "agent_harness_id",
          "channel",
          "chat_type",
          "created_at",
          "display_name",
          "ended_at",
          "model",
          "model_provider",
          "parent_session_key",
          "session_key",
          "session_scope",
          "spawned_by",
          "started_at",
          "status",
          "updated_at",
        ])
        .where("session_id", "=", "normalized-session"),
    );
    expect(session).toEqual({
      account_id: "acct-1",
      agent_harness_id: "codex",
      channel: "discord",
      chat_type: "group",
      created_at: 50,
      display_name: "Example group",
      ended_at: 90,
      model: "gpt-5.5",
      model_provider: "openai",
      parent_session_key: "agent:main:parent",
      session_key: "agent:main:group:example",
      session_scope: "group",
      spawned_by: "agent:main:spawner",
      started_at: 60,
      status: "done",
      updated_at: expect.any(Number),
    });

    const route = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_routes")
        .select(["session_id", "updated_at"])
        .where("session_key", "=", "agent:main:group:example"),
    );
    expect(route).toEqual({
      session_id: "normalized-session",
      updated_at: expect.any(Number),
    });
  });

  it("normalizes missing entry updatedAt before writing root and entry rows", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: paths.stateDir };
    await replaceSqliteSessionEntry(
      {
        agentId: "main",
        env,
        sessionKey: "agent:main:minimal",
        storePath: paths.sqlitePath,
      },
      {
        sessionId: "minimal-session",
        sessionStartedAt: 123,
      } as SessionEntry,
    );

    const loaded = loadSqliteSessionEntry({
      agentId: "main",
      env,
      sessionKey: "agent:main:minimal",
      storePath: paths.sqlitePath,
    });
    expect(loaded).toMatchObject({
      sessionId: "minimal-session",
      sessionStartedAt: 123,
      updatedAt: 123,
    });

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: paths.sqlitePath,
    });
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("sessions as s")
        .innerJoin("session_entries as se", "se.session_id", "s.session_id")
        .innerJoin("session_routes as sr", "sr.session_key", "se.session_key")
        .select([
          "s.created_at as root_created_at",
          "s.updated_at as root_updated_at",
          "se.entry_json",
          "se.updated_at as entry_updated_at",
          "sr.updated_at as route_updated_at",
        ])
        .where("s.session_id", "=", "minimal-session"),
    );
    expect(row).toEqual({
      entry_json: JSON.stringify({
        sessionId: "minimal-session",
        sessionStartedAt: 123,
        updatedAt: 123,
      }),
      entry_updated_at: 123,
      root_created_at: 123,
      root_updated_at: 123,
      route_updated_at: 123,
    });

    await upsertSqliteSessionEntry(
      {
        agentId: "main",
        env,
        sessionKey: "agent:main:minimal-upsert",
        storePath: paths.sqlitePath,
      },
      {
        sessionId: "minimal-upsert-session",
      },
    );
    const upsertRow = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_entries")
        .select(["entry_json", "updated_at"])
        .where("session_key", "=", "agent:main:minimal-upsert"),
    );
    const upsertEntry = JSON.parse(upsertRow?.entry_json ?? "{}") as Partial<SessionEntry>;
    expect(upsertEntry).toMatchObject({
      sessionId: "minimal-upsert-session",
      updatedAt: expect.any(Number),
    });
    expect(upsertRow?.updated_at).toBe(upsertEntry.updatedAt);
  });
});
