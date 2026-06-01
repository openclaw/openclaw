import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  listSessionEntries,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntry,
  publishTranscriptUpdate,
  readSessionUpdatedAt,
  replaceSessionEntry,
  updateSessionEntry,
  upsertSessionEntry,
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
  listSqliteSessionEntries,
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
  entryScope(paths: TestPaths): SessionAccessScope;
  transcriptReadScope(paths: TestPaths, id?: string): SessionTranscriptReadScope;
  transcriptScope(paths: TestPaths, id?: string): SessionTranscriptAccessScope;
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
  listSessionEntries,
  readSessionUpdatedAt,
  upsertSessionEntry,
  replaceSessionEntry,
  patchSessionEntry,
  updateSessionEntry,
  loadTranscriptEvents,
  appendTranscriptEvent,
  appendTranscriptMessage,
  publishTranscriptUpdate,
};

const sqliteAdapter: AccessorAdapter = {
  name: "sqlite",
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
  listSessionEntries: listSqliteSessionEntries,
  readSessionUpdatedAt: readSqliteSessionUpdatedAt,
  upsertSessionEntry: upsertSqliteSessionEntry,
  replaceSessionEntry: replaceSqliteSessionEntry,
  patchSessionEntry: patchSqliteSessionEntry,
  updateSessionEntry: updateSqliteSessionEntry,
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

    it("conforms for raw transcript event load and append", async () => {
      const scope = adapter.transcriptScope(paths);
      const readScope = adapter.transcriptReadScope(paths);
      const event = {
        id: "event-1",
        message: { role: "user", content: "hello" },
        parentId: null,
        type: "message",
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
        message: { role: "user", content: "hello" },
        parentId: null,
        type: "message",
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
        message: { role: "assistant", content: "first" },
        parentId: null,
        type: "message",
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
      expect(updates).toEqual([
        expect.objectContaining({
          agentId: "main",
          message: appended?.message,
          messageId: appended?.messageId,
          sessionKey: scope.sessionKey,
        }),
      ]);
    });
  },
);
