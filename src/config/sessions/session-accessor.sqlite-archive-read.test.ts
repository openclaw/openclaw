import { constants as bufferConstants } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { buffer as consumeBuffer } from "node:stream/consumers";
import zlib from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "../../state/openclaw-agent-db-schema-helpers.js";
import * as agentDb from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as archiveCompression from "./archive-compression.js";
import { deleteSessionEntryLifecycle, findTranscriptEvent } from "./session-accessor.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { MAX_TASK_ARCHIVE_RECORD_BYTES } from "./session-accessor.sqlite-archive-stream.js";
import * as archiveWorker from "./session-accessor.sqlite-archive.js";
import { seedUnindexedTranscriptForTest } from "./session-accessor.sqlite-import.test-support.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { listSessionTranscriptArchivesReadOnly } from "./session-history-read.js";
import * as history from "./session-history.js";
import * as historyReaders from "./session-transcript-worker-readers.js";
import { messageEvent } from "./transcript-message.test-support.js";

const autoTempDirs = useAutoCleanupTempDirTracker(afterEach);
const jsonLines = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function assistantMessage<T>(id: string | undefined, content: T, runId: string, display?: true) {
  return {
    type: "message",
    ...(id === undefined ? {} : { id }),
    message: { role: "assistant", content, ...(display ? { display } : {}), __openclaw: { runId } },
  };
}

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

function createArchiveStore(label: string, filename = "archive.sqlite") {
  const env = { OPENCLAW_STATE_DIR: autoTempDirs.make(label) };
  const storePath = path.join(env.OPENCLAW_STATE_DIR, filename);
  const options = { agentId: "main", env, path: storePath };
  const database = agentDb.openOpenClawAgentDatabase(options);
  const sql = getSessionKysely(database.db);
  const write = (query: Parameters<typeof executeSqliteQuerySync>[1]) =>
    agentDb.runOpenClawAgentWriteTransaction(
      () => executeSqliteQuerySync(database.db, query),
      options,
    );
  return {
    env,
    storePath,
    options,
    database,
    insert: (rows: ReturnType<typeof archiveRow> | ReturnType<typeof archiveRow>[]) =>
      write(sql.insertInto("session_transcript_archives").values(rows)),
    update: (
      id: string,
      row: Partial<ReturnType<typeof archiveRow>>,
      column: "generation" | "session_id" = "generation",
    ) => write(sql.updateTable("session_transcript_archives").set(row).where(column, "=", id)),
    remove: (generations: string[]) =>
      write(sql.deleteFrom("session_transcript_archives").where("generation", "in", generations)),
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
  agentDb.closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it("pages the unique run generation and rejects replaced, deleted, corrupt, or ambiguous continuations", async () => {
  const { env, storePath, options, insert, update, remove } = createArchiveStore(
    "openclaw-archive-page-read-",
  );
  const sessionId = "reused-session";
  const sessionKey = "agent:main:completed";
  const scope = { agentId: "main", env, storePath, sessionKey };
  const runId = "original-run";
  const readPage = (
    request: Partial<Parameters<typeof history.readSessionTaskArchivePageReadOnly>[1]> = {},
  ) => history.readSessionTaskArchivePageReadOnly(scope, { runId, ...request });
  const readBoundedPage = (cursor?: string) => readPage({ maxBytes: 512, cursor });
  const user = {
    type: "message",
    id: "user",
    message: { role: "user", content: "Original request" },
  };
  const answer = assistantMessage("answer", "Original answer", runId);
  const answerFor = (nextRunId: string, content = answer.message.content) => ({
    ...answer,
    message: { ...answer.message, content, __openclaw: { runId: nextRunId } },
  });
  const archive = (
    generation: string,
    reply: typeof answer & { parentId?: string } = answer,
    headerId = sessionId,
    middle: unknown[] = [],
  ) =>
    archiveRow(
      sessionId,
      sessionKey,
      Buffer.from(jsonLines([{ type: "session", id: headerId }, user, ...middle, reply])),
      { generation, name: `${generation}.jsonl`, createdAt: generation === "original" ? 1 : 2 },
    );
  const original = archive("original");
  const successor = archive(
    "successor",
    {
      ...answerFor("next-run", "Unrelated successor"),
      id: "successor-answer",
      parentId: "user",
    },
    sessionId,
    [{ ...answer, parentId: "user" }],
  );
  const replaceOriginal = (value: ReturnType<typeof archive>) => update("original", value);
  insert([original, successor]);
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
      history.verifySessionTranscriptArchivePageBindingReadOnly(scope, runId, page.binding);
    const expectUnavailable = async (message: string | RegExp, request = {}) => {
      await expect(readPage(request)).rejects.toThrow(message);
      await expect(verifyBinding()).rejects.toThrow(message);
    };
    const older = await readPage(continuation);
    expect(older?.entries).toEqual([{ event: user, seq: 1 }]);
    expect(older?.nextCursor).toBeUndefined();
    await verifyBinding();
    update(
      "successor",
      archive("successor", answerFor("next-run", "x".repeat(MAX_TASK_ARCHIVE_RECORD_BYTES))),
    );
    // The capped candidate cannot establish whether the readable match is unique.
    await expectUnavailable(
      "Archived transcript is unavailable because a record exceeds the task-history read capacity.",
    );
    update("successor", successor);
    await expect(readPage({ ...continuation, runId: "next-run" })).rejects.toThrow(
      "Invalid archived transcript cursor",
    );

    replaceOriginal(
      archive(
        "original",
        {
          ...answerFor("next-run"),
          id: "successor-answer",
          parentId: "user",
        },
        sessionId,
        [{ ...answer, parentId: "user" }],
      ),
    );
    await expectUnavailable("run is not on the active branch");

    const replaceBytes = (bytes: Buffer) =>
      replaceOriginal({ ...original, archive_blob: bytes, archive_sha256: digest(bytes) });
    const replaceEvents = (events: unknown[]) =>
      replaceBytes(Buffer.from(jsonLines([{ type: "session", id: sessionId }, ...events])));
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
    const tail = await readBoundedPage();
    expect(tail?.entries).toEqual([{ event: answer, seq: 3 }]);
    expect(tail?.omittedOversized).toBeUndefined();
    expect(tail?.nextCursor).toEqual(expect.any(String));
    const omitted = await readBoundedPage(tail?.nextCursor);
    expect(omitted?.entries).toEqual([]);
    expect(omitted?.omittedOversized).toBe(true);
    expect(omitted?.nextCursor).toEqual(expect.any(String));
    expect(omitted?.nextCursor).not.toBe(tail?.nextCursor);
    const beginning = await readBoundedPage(omitted?.nextCursor);
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
    const failureJson = (content: unknown) => JSON.stringify({ ...failure, content });
    const answerJson = (content: unknown) =>
      JSON.stringify({ ...answer, message: { ...answer.message, content } });
    const rawCases: Array<[string, boolean]> = [
      [failureJson(largeText), true],
      [failureJson([{ type: "text", text: largeText }]), true],
      [
        failureJson(Array.from({ length: 3 }, () => ({ type: "text", text: "x".repeat(200) }))),
        true,
      ],
      [`{"content":"${largeText}",${JSON.stringify(failure).slice(1)}`, false],
      [
        `${JSON.stringify(failure).slice(0, -1)},"content":[{"type":"text","text":"${largeText}","text":"Original failure"}]}`,
        false,
      ],
      [answerJson(largeText), true],
      [answerJson([{ type: "text", text: largeText }]), true],
      [`{${" ".repeat(2048)}\n${smallAnswer.slice(1)}`, false],
      [`{"message":{"content":"${largeText}"},${smallAnswer.slice(1)}`, false],
      [
        `{"type":"message","id":"answer","message":{"role":"assistant","content":[{"type":"text","text":"${largeText}","text":"Original answer"}],"__openclaw":{"runId":"original-run"}}}`,
        false,
      ],
      [
        `{"discarded":"${largeText}","discarded":null,"type":"message","id":"answer","m\\u0065ssage":{"role":"assistant","content":"Original answer","__openclaw":{"runId":"wrong","runId":"original-run"}}}`,
        false,
      ],
      [JSON.stringify({ ...answer, opaque: largeText }), true],
      [`${smallAnswer.slice(0, -1)},"opaque":"\\u0000\\ud800"}`, false],
      [`${smallAnswer.slice(0, -1)},"nested":${"[".repeat(1001)}0${"]".repeat(1001)}}`, true],
    ];
    for (const [raw, expectsOmission] of rawCases) {
      replaceBytes(Buffer.from(`${JSON.stringify({ type: "session", id: sessionId })}\n${raw}`));
      const actual = await readPage({ maxBytes: 512 });
      expect(actual?.totalMessages).toBe(1);
      expect(actual?.entries).toEqual(expectsOmission ? [] : [{ event: JSON.parse(raw), seq: 1 }]);
      expect(actual?.omittedOversized).toBe(expectsOmission ? true : undefined);
    }

    replaceBytes(
      Buffer.from(`${JSON.stringify({ type: "session", id: sessionId })}\n{"broken":!}`),
    );
    await expect(readPage({ maxBytes: 512 })).rejects.toThrow();

    replaceOriginal(archive("original", answerFor(runId, "Replacement")));
    await expectUnavailable("identity changed", continuation);

    replaceOriginal({ ...original, archive_blob: Buffer.from("corrupt") });
    await expectUnavailable("registered hash", continuation);

    replaceOriginal(archive("original", answer, "wrong-session"));
    await expect(readPage()).rejects.toThrow("header does not match");

    replaceOriginal(original);
    insert(archive("ambiguous"));
    await expect(readPage()).rejects.toThrow("Multiple archived transcript generations");
    await expect(verifyBinding()).rejects.toThrow(
      /Multiple archived transcript generations|identity changed/,
    );
    remove(["original", "ambiguous", "successor"]);
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
        history.findSessionTranscriptArchiveEventReadOnly(
          { ...options, storePath: missingPath, sessionKey: "agent:main:missing" },
          "absent-run",
        ),
      ),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(missingPath)).toBe(false);
    expect(archiveRead).not.toHaveBeenCalled();
    const database = agentDb.openOpenClawAgentDatabase(options);
    database.db.exec("DROP TABLE session_transcript_archives");
    assertOpenClawAgentCurrentRuntimeSchema(requireNativeSqliteDatabase(database.db), {
      agentId: database.agentId,
      pathname: database.path,
    });
    const storePath = database.path;
    agentDb.closeOpenClawAgentDatabasesForTest();
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
    await expect(
      withoutHostSql(() => history.findSessionTranscriptArchiveEventReadOnly(scope, "absent-run")),
    ).resolves.toBeUndefined();
    expect(archiveRead).not.toHaveBeenCalled();
    archiveRead.mockRestore();
    {
      using persisted = new DatabaseSync(storePath, { readOnly: true });
      expect(
        persisted
          .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'session_transcript_archives'")
          .get(),
      ).toBeUndefined();
    }
    expect(fs.readFileSync(storePath)).toEqual(before);
  });
});

it.each([false, true])(
  "reads committed archive blobs before file publication (compressed=%s)",
  async (compressed) => {
    const { env, storePath, database, insert, update } = createArchiveStore(
      "openclaw-archive-blob-read-",
      "shared.sqlite",
    );
    const sessionKey = "agent:ops:completed";
    const message = (id: string, content = id, runId = "completed-run") =>
      assistantMessage(id, content, runId);
    const answer = assistantMessage(
      "latest",
      `${'你好 🦞 {result} "quoted" \\ '.repeat(4_000)}tail`,
      "completed-run",
      true,
    );
    const archives: Array<[string, string, unknown[], string?]> = [
      ["old", sessionKey, [message("old")]],
      [
        "new",
        sessionKey,
        [
          message("earlier"),
          answer,
          message("other-run", "unrelated", "other-run"),
          message("silent", "NO_REPLY"),
        ],
      ],
      ["foreign", "agent:main:other", [answer]],
      ["invalid", "agent:ops:invalid", [answer]],
      ["malformed", "agent:ops:malformed", [answer], '\n{\n"message": !\n}\n'],
      ["truncated", "agent:ops:truncated", [answer], '\n{\n"message": {\n'],
    ];
    insert(
      archives.map(([sessionId, key, events, suffix], index) => {
        const content =
          jsonLines([
            { type: "session", id: sessionId === "invalid" ? "wrong" : sessionId },
            ...events,
          ]) + (suffix ?? "");
        const encoded = compressed
          ? archiveCompression.encodeSessionArchiveContent(content)
          : { bytes: Buffer.from(content), suffix: "" };
        return archiveRow(sessionId, key, encoded.bytes, {
          encoding: encoded.suffix ? "zstd" : "identity",
          name: `archive-${index}.jsonl${encoded.suffix}`,
          createdAt: index,
        });
      }),
    );
    const scope = { agentId: "ops", env, storePath, sessionKey };
    const find = (sessionId?: string, runId = "completed-run") =>
      history.findSessionTranscriptArchiveEventReadOnly(
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

    const changedContent = jsonLines([
      { type: "session", id: "new" },
      message("latest", "changed but valid transcript content"),
    ]);
    const changedBytes = compressed
      ? archiveCompression.encodeSessionArchiveContent(changedContent).bytes
      : Buffer.from(changedContent);
    update("new", { archive_blob: changedBytes }, "session_id");
    await expect(find("new")).rejects.toThrow(
      "Archived transcript bytes do not match their registered hash",
    );

    const entered = createDeferred();
    const release = createDeferred();
    const hold = async <T>(value: T) => {
      entered.resolve();
      await release.promise;
      return value;
    };
    const replacementPath = `${storePath}.replacement`;
    const originalPath = `${storePath}.original`;
    const intercept = async () => {
      if (!compressed) {
        const createReaders = historyReaders.createSessionHistoryWorkerReaders;
        return vi
          .spyOn(historyReaders, "createSessionHistoryWorkerReaders")
          .mockImplementation((runRequest) => {
            const readers = createReaders(runRequest);
            return {
              ...readers,
              readArchivePresence: async (input) => hold(await readers.readArchivePresence(input)),
            };
          });
      }
      await agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
      fs.copyFileSync(storePath, replacementPath);
      expect(fs.readFileSync(replacementPath)).toEqual(fs.readFileSync(storePath));
      const scopeOwner = await import("./session-accessor.sqlite-scope.js");
      const prepare = scopeOwner.prepareSqliteScope;
      return vi
        .spyOn(scopeOwner, "prepareSqliteScope")
        .mockImplementation(async (input) => hold(await prepare(input)));
    };
    const interception = await intercept();
    const archiveRead = vi.spyOn(archiveWorker, "runSqliteTranscriptArchiveReadWorker");
    const outcome = find("old").then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let closing: Promise<void> | undefined;
    let originalMoved = false;
    let replacementMoved = false;
    try {
      await Promise.race([
        entered.promise,
        outcome.then(() => {
          throw new Error(
            `Archive lookup settled before its ${compressed ? "scope preparation" : "metadata"} hold`,
          );
        }),
      ]);
      if (compressed) {
        fs.renameSync(storePath, originalPath);
        originalMoved = true;
        fs.renameSync(replacementPath, storePath);
        replacementMoved = true;
      } else {
        closing = agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
      }
      release.resolve();
      expect(await outcome).toMatchObject({
        error: { message: expect.stringMatching(compressed ? /identity changed/ : /revoked/) },
      });
      await closing;
      expect(archiveRead).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([outcome, closing]);
      if (compressed) {
        await agentDb.closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
        if (replacementMoved) {
          fs.renameSync(storePath, replacementPath);
        }
        if (originalMoved) {
          fs.renameSync(originalPath, storePath);
        }
      }
      archiveRead.mockRestore();
      interception.mockRestore();
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
      ...assistantMessage(
        "answer",
        [{ type: "text", text: 'Complete result: {"answer": "你好 🦞"}.' }],
        runId,
      ),
      parentId: "user",
    };
    const rows = [
      { type: "session", version: 3, id: sessionId },
      messageEvent("user", null, {
        role: "user",
        content: 'Keep braces {}, brackets [] and \\"quotes\\".',
      }),
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
    const archivePath = deletion.archivedTranscripts[0]!.archivedPath;
    expect(archiveCompression.readSessionArchiveContentSync(archivePath)).toBe(
      `${rows.map((row) => row.event_json).join("\n")}\n`,
    );
    await expect(history.findSessionTranscriptArchiveEventReadOnly(scope, runId)).resolves.toEqual({
      event: answer,
    });
  });
});

it("reads a short final answer beyond the runtime string limit while the caller stays responsive", async () => {
  const { env, storePath, insert } = createArchiveStore("openclaw-large-archive-read-");
  const sessionId = "large-archive";
  const sessionKey = "agent:main:completed";
  const answer = assistantMessage(undefined, "Complete final answer.", "completed-run");
  const historyLine =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "x".repeat(64 * 1024) },
    }) + "\n";
  // The September 2026 failure was the runtime's single-string limit, not an archive byte limit.
  const historyRows = Math.ceil((bufferConstants.MAX_STRING_LENGTH + 1) / historyLine.length);
  const compressed = Readable.from([
    JSON.stringify({ type: "session", id: sessionId }) + "\n",
    ...Array.from({ length: historyRows }, () => historyLine),
    JSON.stringify(answer) + "\n",
  ]).pipe(zlib.createZstdCompress());
  const bytes = await consumeBuffer(compressed);
  insert(
    archiveRow(sessionId, sessionKey, bytes, {
      encoding: "zstd",
      name: "large.jsonl.zst",
      createdAt: 1,
    }),
  );
  let heartbeats = 0;
  const heartbeat = setInterval(() => {
    heartbeats += 1;
  }, 10);
  try {
    await expect(
      history.findSessionTranscriptArchiveEventReadOnly(
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
