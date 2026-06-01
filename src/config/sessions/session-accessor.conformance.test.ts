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
    options?: { fallbackEntry?: SessionEntry; replaceEntry?: boolean },
  ): Promise<SessionEntry | null>;
  updateSessionEntry(
    scope: SessionAccessScope,
    update: (entry: SessionEntry) => Partial<SessionEntry> | null,
  ): Promise<SessionEntry | null>;
  loadTranscriptEvents(scope: SessionTranscriptAccessScope): Promise<TranscriptEvent[]>;
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
    });

    it("conforms for raw transcript event load and append", async () => {
      const scope = adapter.transcriptScope(paths);
      const event = {
        id: "event-1",
        message: { role: "user", content: "hello" },
        parentId: null,
        type: "message",
      };

      await adapter.appendTranscriptEvent(scope, { type: "session", sessionId: "session-1" });
      await adapter.appendTranscriptEvent(scope, event);

      await expect(adapter.loadTranscriptEvents(scope)).resolves.toEqual([
        { type: "session", sessionId: "session-1" },
        event,
      ]);
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
