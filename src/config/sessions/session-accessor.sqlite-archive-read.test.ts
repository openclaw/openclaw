import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "../../state/openclaw-agent-db-schema-helpers.js";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
} from "./archive-compression.js";
import { deleteSessionEntryLifecycle, findTranscriptEvent } from "./session-accessor.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { MAX_TASK_ARCHIVE_RECORD_BYTES } from "./session-accessor.sqlite-archive-stream.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  findSessionTranscriptArchiveEventReadOnly,
  listSessionTranscriptArchivesReadOnly,
  readSessionTaskArchivePageReadOnly,
  verifySessionTranscriptArchivePageBindingReadOnly,
} from "./session-history.js";
import * as historyReaders from "./session-transcript-worker-readers.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);
const jsonLines = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function archiveRow(
  sessionId: string,
  sessionKey: string,
  bytes: Buffer,
  options: { generation?: string; encoding?: "identity" | "zstd"; name: string; createdAt: number },
) {
  return {
    session_id: sessionId,
    session_key: sessionKey,
    generation: options.generation ?? "generation",
    reason: "deleted" as const,
    encoding: options.encoding ?? "identity",
    archive_blob: bytes,
    archive_sha256: digest(bytes),
    archive_name: options.name,
    created_at: options.createdAt,
    published_at: null,
  };
}

async function withoutHostSql<T>(read: () => Promise<T>): Promise<T> {
  const hostSql = observeHostDataSql();
  const result = await read().finally(() => hostSql.restore());
  expect(hostSql.queries).toEqual([]);
  for (const call of hostSql.calls) {
    expect(call).not.toHaveBeenCalled();
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("SQLite transcript archive reads", () => {
  it("pages the unique run generation and rejects replaced, deleted, corrupt, or ambiguous continuations", async () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-archive-page-read-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "archive.sqlite");
    const options = { agentId: "main", env, path: storePath };
    const database = openOpenClawAgentDatabase(options);
    const sessionId = "reused-session";
    const sessionKey = "agent:main:completed";
    const scope = { agentId: "main", env, storePath, sessionKey };
    const runId = "original-run";
    const readPage = (
      request: Omit<Parameters<typeof readSessionTaskArchivePageReadOnly>[1], "runId"> & {
        runId?: string;
      } = {},
    ) => readSessionTaskArchivePageReadOnly(scope, { runId, ...request });
    const user = {
      type: "message",
      id: "user",
      message: { role: "user", content: "Original request" },
    };
    const answer = {
      type: "message",
      id: "answer",
      message: { role: "assistant", content: "Original answer", __openclaw: { runId } },
    };
    const archive = (
      generation: string,
      reply: typeof answer & { parentId?: string } = answer,
      headerId = sessionId,
      middle: unknown[] = [],
    ) => {
      const bytes = Buffer.from(
        jsonLines([{ type: "session", id: headerId }, user, ...middle, reply]),
      );
      return archiveRow(sessionId, sessionKey, bytes, {
        generation,
        name: `${generation}.jsonl`,
        createdAt: generation === "original" ? 1 : 2,
      });
    };
    const original = archive("original");
    const successor = archive(
      "successor",
      {
        ...answer,
        id: "successor-answer",
        parentId: "user",
        message: {
          ...answer.message,
          content: "Unrelated successor",
          __openclaw: { runId: "next-run" },
        },
      },
      sessionId,
      [{ ...answer, parentId: "user" }],
    );
    const write = (run: () => void) => runOpenClawAgentWriteTransaction(run, options);
    const replaceOriginal = (value: ReturnType<typeof archive>) =>
      write(() => {
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .updateTable("session_transcript_archives")
            .set(value)
            .where("generation", "=", "original"),
        );
      });
    write(() => {
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .insertInto("session_transcript_archives")
          .values([original, successor]),
      );
    });
    await withSqliteTranscriptArchiveSession(options, async () => {
      const page = await readPage({ limit: 1 });
      expect(page?.entries).toEqual([{ event: answer, seq: 2 }]);
      expect(page?.totalMessages).toBe(2);
      expect(page?.binding.generation).toBe("original");
      expect(page?.nextCursor).toEqual(expect.any(String));
      if (!page?.nextCursor) {
        throw new Error("Expected an older archive page");
      }
      const continuation = { runId, limit: 1, cursor: page.nextCursor };
      const verifyBinding = () =>
        verifySessionTranscriptArchivePageBindingReadOnly(scope, runId, page.binding);
      const expectUnavailable = async (message: string | RegExp, request = {}) => {
        await expect(readPage(request)).rejects.toThrow(message);
        await expect(verifyBinding()).rejects.toThrow(message);
      };
      const older = await readPage(continuation);
      expect(older?.entries).toEqual([{ event: user, seq: 1 }]);
      expect(older?.nextCursor).toBeUndefined();
      await verifyBinding();
      const oversizedSuccessor = archive("successor", {
        ...answer,
        message: {
          ...answer.message,
          content: "x".repeat(MAX_TASK_ARCHIVE_RECORD_BYTES),
          __openclaw: { runId: "next-run" },
        },
      });
      const replaceSuccessor = (value: typeof successor) =>
        write(() => {
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .updateTable("session_transcript_archives")
              .set(value)
              .where("generation", "=", "successor"),
          );
        });
      replaceSuccessor(oversizedSuccessor);
      // The capped candidate cannot establish whether the readable match is unique.
      await expectUnavailable(
        "Archived transcript is unavailable because a record exceeds the task-history read capacity.",
      );
      replaceSuccessor(successor);
      await expect(readPage({ ...continuation, runId: "next-run" })).rejects.toThrow(
        "Invalid archived transcript cursor",
      );

      replaceOriginal(
        archive(
          "original",
          {
            ...answer,
            id: "successor-answer",
            parentId: "user",
            message: { ...answer.message, __openclaw: { runId: "next-run" } },
          },
          sessionId,
          [{ ...answer, parentId: "user" }],
        ),
      );
      await expectUnavailable("run is not on the active branch");

      const replaceEvents = (events: unknown[]) => {
        const bytes = Buffer.from(jsonLines([{ type: "session", id: sessionId }, ...events]));
        replaceOriginal({
          ...original,
          archive_blob: bytes,
          archive_sha256: digest(bytes),
        });
      };
      const root = { ...user, parentId: null };
      const reply = { ...answer, parentId: user.id };
      const contextBefore = { ...answer, id: "context-before" };
      const contextSelected = { ...answer, id: "context-selected" };
      replaceEvents([user, contextBefore, contextSelected, answer]);
      const contextTail = await readPage({ limit: 1 });
      if (!contextTail?.nextCursor) {
        throw new Error("Expected a bounded projection-context page");
      }
      const selectedAndNewerBytes = Buffer.byteLength(
        JSON.stringify(contextSelected) + JSON.stringify(answer),
      );
      for (const maxBytes of [4096, selectedAndNewerBytes]) {
        const pageWithContext = await readPage({
          limit: 1,
          contextMaxMessages: 2,
          maxBytes,
          cursor: contextTail.nextCursor,
        });
        expect(pageWithContext?.entries).toEqual([{ event: contextSelected, seq: 3 }]);
        expect(pageWithContext?.contextEntries).toEqual([
          ...(maxBytes === 4096 ? [{ event: contextBefore, seq: 2 }] : []),
          { event: answer, seq: 4 },
        ]);
      }
      replaceEvents([
        root,
        ...Array.from({ length: 1025 }, (_, index) => ({
          ...reply,
          id: `side-${index}`,
          appendMode: "side",
          message: { role: "assistant", content: "Inactive branch" },
        })),
        reply,
      ]);
      expect((await readPage())?.entries).toEqual([
        { event: root, seq: 1 },
        { event: reply, seq: 1027 },
      ]);
      // Duplicate IDs resolve to the latest node; a cycle discards the whole path.
      replaceEvents([root, reply, { ...reply, message: { ...reply.message, content: "Latest" } }]);
      expect((await readPage())?.entries).toEqual([
        { event: root, seq: 1 },
        {
          event: { ...reply, message: { ...reply.message, content: "Latest" } },
          seq: 3,
        },
      ]);
      replaceEvents([root, reply, { ...root, parentId: answer.id }]);
      await expect(readPage()).rejects.toThrow("run is not on the active branch");

      for (const invalidControl of [{ appendMode: false }, { appendParentId: { invalid: true } }]) {
        replaceEvents([
          root,
          reply,
          {
            type: "leaf",
            id: "invalid-leaf",
            parentId: reply.id,
            targetId: root.id,
            ...invalidControl,
          },
        ]);
        expect((await readPage())?.entries).toEqual([
          { event: root, seq: 1 },
          { event: reply, seq: 2 },
        ]);
      }
      replaceEvents([root, { ...reply, parentId: false }]);
      await expect(readPage()).rejects.toThrow("run is not on the active branch");

      replaceOriginal(
        archive("original", answer, sessionId, [
          {
            ...answer,
            id: "large",
            message: { ...answer.message, content: "x".repeat(2048) },
          },
        ]),
      );
      const tail = await readPage({ maxBytes: 512 });
      expect(tail?.entries).toEqual([{ event: answer, seq: 3 }]);
      expect(tail?.omittedOversized).toBeUndefined();
      expect(tail?.nextCursor).toEqual(expect.any(String));
      const omitted = await readPage({
        maxBytes: 512,
        cursor: tail?.nextCursor,
      });
      expect(omitted?.entries).toEqual([]);
      expect(omitted?.omittedOversized).toBe(true);
      expect(omitted?.nextCursor).toEqual(expect.any(String));
      expect(omitted?.nextCursor).not.toBe(tail?.nextCursor);
      const beginning = await readPage({
        maxBytes: 512,
        cursor: omitted?.nextCursor,
      });
      expect(beginning?.entries).toEqual([{ event: user, seq: 1 }]);
      expect(beginning?.nextCursor).toBeUndefined();

      // Raw JSON keeps last-key, Unicode, and whitespace semantics under the page byte budget.
      const largeText = "x".repeat(2048);
      const smallAnswer = JSON.stringify(answer);
      const failure = {
        type: "custom_message",
        id: "failure",
        customType: "run-failed-before-reply",
        display: true,
        details: { runId },
        content: "Original failure",
      };
      const rawCases = [
        { raw: JSON.stringify({ ...failure, content: largeText }), omitted: true },
        {
          raw: JSON.stringify({ ...failure, content: [{ type: "text", text: largeText }] }),
          omitted: true,
        },
        {
          raw: JSON.stringify({
            ...failure,
            content: Array.from({ length: 3 }, () => ({ type: "text", text: "x".repeat(200) })),
          }),
          omitted: true,
        },
        {
          raw: `{"content":"${largeText}",${JSON.stringify(failure).slice(1)}`,
          omitted: false,
        },
        {
          raw: `${JSON.stringify(failure).slice(0, -1)},"content":[{"type":"text","text":"${largeText}","text":"Original failure"}]}`,
          omitted: false,
        },
        {
          raw: JSON.stringify({ ...answer, message: { ...answer.message, content: largeText } }),
          omitted: true,
        },
        {
          raw: JSON.stringify({
            ...answer,
            message: { ...answer.message, content: [{ type: "text", text: largeText }] },
          }),
          omitted: true,
        },
        { raw: `{${" ".repeat(2048)}\n${smallAnswer.slice(1)}`, omitted: false },
        { raw: `{"message":{"content":"${largeText}"},${smallAnswer.slice(1)}`, omitted: false },
        {
          raw: `{"type":"message","id":"answer","message":{"role":"assistant","content":[{"type":"text","text":"${largeText}","text":"Original answer"}],"__openclaw":{"runId":"original-run"}}}`,
          omitted: false,
        },
        {
          raw: `{"discarded":"${largeText}","discarded":null,"type":"message","id":"answer","m\\u0065ssage":{"role":"assistant","content":"Original answer","__openclaw":{"runId":"wrong","runId":"original-run"}}}`,
          omitted: false,
        },
        { raw: JSON.stringify({ ...answer, opaque: largeText }), omitted: true },
        { raw: `${smallAnswer.slice(0, -1)},"opaque":"\\u0000\\ud800"}`, omitted: false },
        {
          raw: `${smallAnswer.slice(0, -1)},"nested":${"[".repeat(1001)}0${"]".repeat(1001)}}`,
          omitted: true,
        },
      ];
      for (const { raw, omitted: expectsOmission } of rawCases) {
        const bytes = Buffer.from(`${JSON.stringify({ type: "session", id: sessionId })}\n${raw}`);
        replaceOriginal({
          ...original,
          archive_blob: bytes,
          archive_sha256: digest(bytes),
        });
        const actual = await readPage({ maxBytes: 512 });
        expect(actual?.totalMessages).toBe(1);
        if (expectsOmission) {
          expect(actual?.entries).toEqual([]);
          expect(actual?.omittedOversized).toBe(true);
        } else {
          expect(actual?.entries).toEqual([{ event: JSON.parse(raw), seq: 1 }]);
          expect(actual?.omittedOversized).toBeUndefined();
        }
      }

      const malformedBytes = Buffer.from(
        `${JSON.stringify({ type: "session", id: sessionId })}\n{"broken":!}`,
      );
      replaceOriginal({
        ...original,
        archive_blob: malformedBytes,
        archive_sha256: digest(malformedBytes),
      });
      await expect(readPage({ maxBytes: 512 })).rejects.toThrow();

      replaceOriginal(
        archive("original", { ...answer, message: { ...answer.message, content: "Replacement" } }),
      );
      await expectUnavailable("identity changed", continuation);

      replaceOriginal({ ...original, archive_blob: Buffer.from("corrupt") });
      await expectUnavailable("registered hash", continuation);

      replaceOriginal(archive("original", answer, "wrong-session"));
      await expect(readPage()).rejects.toThrow("header does not match");

      replaceOriginal(original);
      write(() => {
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .insertInto("session_transcript_archives")
            .values(archive("ambiguous")),
        );
      });
      await expect(readPage()).rejects.toThrow("Multiple archived transcript generations");
      await expect(verifyBinding()).rejects.toThrow(
        /Multiple archived transcript generations|identity changed/,
      );
      write(() => {
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .deleteFrom("session_transcript_archives")
            .where("generation", "in", ["original", "ambiguous", "successor"]),
        );
      });
      await expectUnavailable("no longer available", continuation);
      await expect(readPage()).resolves.toBeUndefined();
    });
  });

  it("reads a pre-archive store without creating its optional archive table", async () => {
    await withOpenClawTestState({ label: "optional-archive-read" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const archiveRead = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveReadWorker");
      const missingPath = state.statePath("missing.sqlite");
      await expect(
        withoutHostSql(() =>
          findSessionTranscriptArchiveEventReadOnly(
            { ...options, storePath: missingPath, sessionKey: "agent:main:missing" },
            "absent-run",
          ),
        ),
      ).resolves.toBeUndefined();
      expect(fs.existsSync(missingPath)).toBe(false);
      expect(archiveRead).not.toHaveBeenCalled();
      const database = openOpenClawAgentDatabase(options);
      database.db.exec("DROP TABLE session_transcript_archives");
      assertOpenClawAgentCurrentRuntimeSchema(requireNativeSqliteDatabase(database.db), {
        agentId: database.agentId,
        pathname: database.path,
      });
      const storePath = database.path;
      closeOpenClawAgentDatabasesForTest();
      const before = fs.readFileSync(storePath);
      const scope = {
        ...options,
        storePath,
        sessionKey: "agent:main:pre-archive",
        sessionId: "pre-archive",
      };

      expect(
        listSessionTranscriptArchivesReadOnly({ ...scope, sessionIds: [scope.sessionId] }),
      ).toEqual([]);
      try {
        await expect(
          withoutHostSql(() => findSessionTranscriptArchiveEventReadOnly(scope, "absent-run")),
        ).resolves.toBeUndefined();
        expect(archiveRead).not.toHaveBeenCalled();
      } finally {
        archiveRead.mockRestore();
      }
      const persisted = new DatabaseSync(storePath, { readOnly: true });
      try {
        expect(
          persisted
            .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_transcript_archives'")
            .get(),
        ).toBeUndefined();
      } finally {
        persisted.close();
      }
      expect(fs.readFileSync(storePath)).toEqual(before);
    });
  });

  it.each([false, true])(
    "reads committed archive blobs before file publication (compressed=%s)",
    async (compressed) => {
      const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-archive-blob-read-") };
      const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared.sqlite");
      const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
      const sessionKey = "agent:ops:completed";
      const message = (id: string, content = id, runId = "completed-run") => ({
        type: "message",
        id,
        message: { role: "assistant", content, __openclaw: { runId } },
      });
      const answer = {
        type: "message",
        id: "latest",
        message: {
          role: "assistant",
          content: `${'你好 🦞 {result} "quoted" \\ '.repeat(4_000)}tail`,
          display: true,
          __openclaw: { runId: "completed-run" },
        },
      };
      const archives = [
        { sessionId: "old", sessionKey, events: [message("old")] },
        {
          sessionId: "new",
          sessionKey,
          events: [
            message("earlier"),
            answer,
            message("other-run", "unrelated", "other-run"),
            message("silent", "NO_REPLY"),
          ],
        },
        { sessionId: "foreign", sessionKey: "agent:main:other", events: [answer] },
        { sessionId: "invalid", sessionKey: "agent:ops:invalid", events: [answer] },
        {
          sessionId: "malformed",
          sessionKey: "agent:ops:malformed",
          events: [answer],
          suffix: '\n{\n"message": !\n}\n',
        },
        {
          sessionId: "truncated",
          sessionKey: "agent:ops:truncated",
          events: [answer],
          suffix: '\n{\n"message": {\n',
        },
      ];
      runOpenClawAgentWriteTransaction(
        () => {
          for (const [index, archive] of archives.entries()) {
            const content =
              [
                {
                  type: "session",
                  id: archive.sessionId === "invalid" ? "wrong" : archive.sessionId,
                },
                ...archive.events,
              ]
                .map((event) => JSON.stringify(event))
                .join("\n") + (archive.suffix ?? "");
            const encoded = compressed
              ? encodeSessionArchiveContent(content)
              : { bytes: Buffer.from(content), suffix: "" };
            executeSqliteQuerySync(
              database.db,
              getSessionKysely(database.db)
                .insertInto("session_transcript_archives")
                .values(
                  archiveRow(archive.sessionId, archive.sessionKey, encoded.bytes, {
                    encoding: encoded.suffix ? "zstd" : "identity",
                    name: `archive-${index}.jsonl${encoded.suffix}`,
                    createdAt: index,
                  }),
                ),
            );
          }
        },
        { agentId: "main", env, path: storePath },
      );
      const scope = { agentId: "ops", env, storePath, sessionKey };
      const find = (sessionId?: string, runId = "completed-run") =>
        findSessionTranscriptArchiveEventReadOnly(
          { ...scope, ...(sessionId ? { sessionId } : {}) },
          runId,
        );
      const files = () =>
        fs
          .readdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, encoding: "utf8" })
          .toSorted((left, right) => left.localeCompare(right));
      const filesBefore = files();

      expect(await withoutHostSql(() => find())).toEqual({ event: answer });
      expect(await find("old")).toEqual({ event: message("old") });
      expect(await find("foreign")).toBeUndefined();
      expect(await find(undefined, "missing-run")).toBeUndefined();
      await expect(find("invalid")).rejects.toThrow(
        "Archived transcript header does not match its registered session",
      );
      for (const sessionId of ["malformed", "truncated"]) {
        await expect(find(sessionId)).rejects.toThrow();
      }
      expect(files()).toEqual(filesBefore);
      expect(
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_transcript_archives")
            .select("published_at"),
        ).rows,
      ).toEqual(archives.map(() => ({ published_at: null })));

      const changedContent = [
        { type: "session", id: "new" },
        message("latest", "changed but valid transcript content"),
      ]
        .map((event) => JSON.stringify(event))
        .join("\n");
      const changedBytes = compressed
        ? encodeSessionArchiveContent(changedContent).bytes
        : Buffer.from(changedContent);
      runOpenClawAgentWriteTransaction(
        () => {
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .updateTable("session_transcript_archives")
              .set({ archive_blob: changedBytes })
              .where("session_id", "=", "new"),
          );
        },
        { agentId: "main", env, path: storePath },
      );
      await expect(find("new")).rejects.toThrow(
        "Archived transcript bytes do not match their registered hash",
      );

      if (!compressed) {
        const entered = createDeferred();
        const release = createDeferred();
        const createReaders = historyReaders.createSessionHistoryWorkerReaders;
        const factory = vi
          .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
          .mockImplementation((runRequest) => {
            const readers = createReaders(runRequest);
            const readPresence = readers.readArchivePresence;
            return {
              ...readers,
              readArchivePresence: async (input) => {
                const registered = await readPresence(input);
                entered.resolve();
                await release.promise;
                return registered;
              },
            };
          });
        const archiveRead = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveReadWorker");
        const outcome = find("old").then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let closing: Promise<void> | undefined;
        try {
          await Promise.race([
            entered.promise,
            outcome.then(() => {
              throw new Error("Archive lookup settled before its metadata hold");
            }),
          ]);
          closing = closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
          release.resolve();
          expect(await outcome).toMatchObject({
            error: { message: expect.stringMatching(/revoked/) },
          });
          await closing;
          expect(archiveRead).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await Promise.allSettled([outcome, closing]);
          archiveRead.mockRestore();
          factory.mockRestore();
        }
      } else {
        await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
        const replacementPath = `${storePath}.replacement`;
        const originalPath = `${storePath}.original`;
        fs.copyFileSync(storePath, replacementPath);
        expect(fs.readFileSync(replacementPath)).toEqual(fs.readFileSync(storePath));
        const scopeOwner = await import("./session-accessor.sqlite-scope.js");
        const prepare = scopeOwner.prepareSqliteScope;
        const entered = createDeferred();
        const release = createDeferred();
        const preparation = vi
          .spyOn(scopeOwner, "prepareSqliteScope")
          .mockImplementation(async (input) => {
            const resolved = await prepare(input);
            entered.resolve();
            await release.promise;
            return resolved;
          });
        const archiveRead = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveReadWorker");
        const outcome = find("old").then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        let originalMoved = false;
        let replacementMoved = false;
        try {
          await Promise.race([
            entered.promise,
            outcome.then(() => {
              throw new Error("Archive lookup settled before its scope preparation hold");
            }),
          ]);
          fs.renameSync(storePath, originalPath);
          originalMoved = true;
          fs.renameSync(replacementPath, storePath);
          replacementMoved = true;
          release.resolve();
          expect(await outcome).toMatchObject({
            error: { message: expect.stringMatching(/identity changed/) },
          });
          expect(archiveRead).not.toHaveBeenCalled();
        } finally {
          release.resolve();
          await outcome;
          await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
          if (replacementMoved) {
            fs.renameSync(storePath, replacementPath);
          }
          if (originalMoved) {
            fs.renameSync(originalPath, storePath);
          }
          archiveRead.mockRestore();
          preparation.mockRestore();
        }
      }
    },
  );

  it("retains exact multiline imported events through deletion and final-answer lookup", async () => {
    await withOpenClawTestState({ label: "archive-multiline" }, async (state) => {
      const sessionId = "imported-child";
      const sessionKey = "agent:main:subagent:imported-child";
      const runId = "imported-child-run";
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId,
        sessionKey,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const answer = {
        type: "message",
        id: "answer",
        parentId: "user",
        message: {
          role: "assistant",
          content: [{ type: "text", text: 'Complete result: {"answer": "你好 🦞"}.' }],
          __openclaw: { runId },
        },
      };
      const rows = [
        { type: "session", version: 3, id: sessionId },
        {
          type: "message",
          id: "user",
          parentId: null,
          message: { role: "user", content: 'Keep braces {}, brackets [] and \\"quotes\\".' },
        },
        answer,
      ].map((event, index) => ({
        session_id: sessionId,
        seq: index,
        created_at: index + 1,
        event_json: JSON.stringify(event, null, 2),
      }));
      await seedUnindexedTranscriptForTest({
        ...scope,
        entry: { sessionId, updatedAt: 3 },
        events: rows,
      });
      await expect(findTranscriptEvent(scope, { kind: "visible-final", runId })).resolves.toEqual({
        event: answer,
      });

      const deletion = await deleteSessionEntryLifecycle({
        ...scope,
        archiveTranscript: true,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });
      expect(deletion.deleted).toBe(true);
      expect(deletion.archivedTranscripts).toHaveLength(1);
      expect(readSessionArchiveContentSync(deletion.archivedTranscripts[0]!.archivedPath)).toBe(
        `${rows.map((row) => row.event_json).join("\n")}\n`,
      );
      await expect(findSessionTranscriptArchiveEventReadOnly(scope, runId)).resolves.toEqual({
        event: answer,
      });
    });
  });

  it("reads a short final answer beyond the runtime string limit while the caller stays responsive", async () => {
    const env = { OPENCLAW_STATE_DIR: autoTempDirs.make("openclaw-large-archive-read-") };
    const storePath = path.join(env.OPENCLAW_STATE_DIR, "archive.sqlite");
    const sessionId = "large-archive";
    const sessionKey = "agent:main:completed";
    const answer = {
      type: "message",
      message: {
        role: "assistant",
        content: "Complete final answer.",
        __openclaw: { runId: "completed-run" },
      },
    };
    const historyLine =
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "x".repeat(64 * 1024) },
      }) + "\n";
    // The September 2026 failure was the runtime's single-string limit, not an archive byte limit.
    const historyRows = Math.ceil((bufferConstants.MAX_STRING_LENGTH + 1) / historyLine.length);
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from(
        (function* () {
          yield JSON.stringify({ type: "session", id: sessionId }) + "\n";
          for (let index = 0; index < historyRows; index += 1) {
            yield historyLine;
          }
          yield JSON.stringify(answer) + "\n";
        })(),
      ),
      zlib.createZstdCompress(),
      async (source) => {
        for await (const chunk of source) {
          chunks.push(Buffer.from(chunk));
        }
      },
    );
    const bytes = Buffer.concat(chunks);
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath });
    runOpenClawAgentWriteTransaction(
      () => {
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .insertInto("session_transcript_archives")
            .values(
              archiveRow(sessionId, sessionKey, bytes, {
                encoding: "zstd",
                name: "large.jsonl.zst",
                createdAt: 1,
              }),
            ),
        );
      },
      { agentId: "main", env, path: storePath },
    );
    let heartbeats = 0;
    const heartbeat = setInterval(() => {
      heartbeats += 1;
    }, 10);
    try {
      await expect(
        findSessionTranscriptArchiveEventReadOnly(
          { agentId: "main", env, storePath, sessionId, sessionKey },
          "completed-run",
        ),
      ).resolves.toEqual({ event: answer });
      expect(heartbeats).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR, "large.jsonl.zst"))).toBe(false);
    } finally {
      clearInterval(heartbeat);
    }
  }, 30_000);
});
