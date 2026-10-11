import assert from "node:assert/strict";
import type { Transferable } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareChatHistoryResponsePage } from "../../gateway/server-methods/chat-history-response-page.js";
import type { SessionArtifactReadQuery } from "../../gateway/session-artifact-read.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { applyAgentDatabaseReaderRequest } from "../../infra/agent-database-readers.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import type { UsageCostWorkerReply } from "../../infra/session-cost-usage-worker.types.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  getOpenClawAgentDatabaseValidationForTransfer,
  releaseOpenClawAgentDatabaseReadValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import type { ChatHistoryPageParams } from "./session-history-types.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerRequest,
  SessionTranscriptWorkerReply,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type WorkerReply =
  | SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>
  | UsageCostWorkerReply;

const worker = vi.hoisted(() => ({
  read: vi.fn<(input: SessionTranscriptWorkerRequest) => Promise<WorkerReply>>(),
  close: vi.fn<(key?: string) => void>(),
  transfers: vi.fn<(reply: WorkerReply) => Transferable[]>(),
}));
vi.mock("../../infra/worker-task-server.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/worker-task-server.js")>()),
  serveOwnedWorkerTasks(
    handler: (input: unknown) => Promise<WorkerReply>,
    options: {
      closeResource: (key?: string) => void;
      transferList?: (reply: WorkerReply) => Transferable[];
    },
  ) {
    worker.read.mockImplementation(handler);
    worker.close.mockImplementation(options.closeResource);
    worker.transfers.mockImplementation(options.transferList ?? (() => []));
  },
}));
import "./session-transcript.worker.js";

it("borrows canonical writer proof without a native reader and still fences foreign changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const opened = openOpenClawAgentDatabase(options);
    const database = { agentId: opened.agentId, path: opened.path };
    const sessionKey = "agent:main:writer-proof";
    replaceSessionEntrySync(
      { ...options, sessionKey },
      { sessionId: "writer-proof", updatedAt: 1 },
    );
    const retained = getOpenClawAgentDatabaseValidationForTransfer(database);
    assert(retained);
    const validation = {
      agentId: retained.agentId,
      identity: retained.identity,
      birthtime: retained.birthtime,
      receiptId: retained.receiptId,
      valid: retained.valid,
      canonicalReady: retained.canonicalReady,
    };
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    // A reader worker starts without the writer's process-local validation metadata.
    releaseOpenClawAgentDatabaseReadValidation([{ path: database.path }]);
    expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
    const request = {
      kind: "session-entry-read" as const,
      database,
      scope: { ...options, sessionKey, storePath: database.path, databaseAgentId: "main" },
      validation,
    };
    const reads = observeSqliteReadSql(nodeSqlite.requireNodeSqlite().StatementSync.prototype);
    try {
      await expect(worker.read(request)).resolves.toMatchObject({
        ok: true,
        value: { kind: "session-entry-read", entry: { sessionId: "writer-proof" } },
      });
      expect(
        reads.queries.filter(
          (sql) =>
            /\bfrom\s+"?session_nodes"?(?:\s|$)/i.test(sql) &&
            /\bjoin\s+"?session_windows"?(?:\s|$)/i.test(sql) &&
            !/\bwhere\b/i.test(sql),
        ),
      ).toEqual([]);
      const peer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(database.path);
      try {
        peer
          .prepare(
            "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
          )
          .run("foreign label", sessionKey);
      } finally {
        peer.close();
      }
      await expect(worker.read(request)).resolves.toMatchObject({
        ok: true,
        value: { kind: "session-entry-read", entry: { label: "foreign label" } },
      });
      await expect(
        worker.read({
          ...request,
          validation: { ...validation, identity: "different-generation" },
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: "read-error", message: expect.stringContaining("validation") },
      });
      await expect(worker.read(request)).resolves.toMatchObject({ ok: true });
      Atomics.store(new Int32Array(validation.valid), 0, 0);
      await expect(worker.read(request)).resolves.toMatchObject({
        ok: false,
        error: { kind: "read-error", message: expect.stringContaining("validation") },
      });
    } finally {
      reads.restore();
      worker.close(JSON.stringify([{ path: database.path }]));
    }
  });
});

it("transfers bounded history JSON without retaining the worker buffer", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "main";
    const sessionKey = "agent:main:history-transfer";
    const sessionId = "history-transfer";
    const { path } = openOpenClawAgentDatabase({ agentId, env: state.env });
    const scope = { agentId, sessionKey, sessionId, storePath: path, env: state.env };
    replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
    for (const [index, length] of [64, 200_000].entries()) {
      appendTranscriptMessageSync(scope, {
        eventId: `message-${index}`,
        message: {
          role: "assistant",
          timestamp: 1_800_000_000_000 + index,
          content: [{ type: "text", text: `Synthetic 漢字🦞\\"\n${"x".repeat(length)}` }],
        },
      });
    }
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const stateContext = captureOpenClawStateReadWorkerContext({ env: state.env });
    const params: ChatHistoryPageParams & { sessionId: string; storePath: string } = {
      entry: undefined,
      provider: undefined,
      sessionId,
      storePath: path,
      sessionAgentId: agentId,
      canonicalKey: sessionKey,
      max: 200,
      maxHistoryBytes: 1024,
      effectiveMaxChars: 300_000,
      offset: undefined,
      messageId: undefined,
    };
    const read = async (encodeResponse: boolean) => {
      const reply = await worker.read({
        kind: "history-page",
        database: { agentId, path },
        request: { kind: "rpc", params: { ...params, encodeResponse } },
        target: {
          transcript: { agentId, sessionId, sessionKey, storePath: path, sessionFile: sessionKey },
          entryValidationKey: sessionKey,
          stateDatabase: {
            path: stateContext.admission.databasePath,
            environment: stateContext.environment,
          },
        },
      });
      assert(reply.ok && typeof reply.value === "object" && reply.value !== null);
      assert("kind" in reply.value && reply.value.kind === "rpc");
      return { reply, page: reply.value.page };
    };
    try {
      const ordinary = await read(false);
      const expected = prepareChatHistoryResponsePage(ordinary.page, params);
      const { reply, page } = await read(true);
      const body = page.encodedResponse?.messages;
      assert(body);
      expect(body.byteLength).toBeLessThanOrEqual(params.maxHistoryBytes);
      expect(JSON.parse(new TextDecoder().decode(body))).toEqual(expected.messages);
      const received = structuredClone(reply, { transfer: worker.transfers(reply) });
      expect(body.byteLength).toBe(0);
      expect(received).toMatchObject({
        ok: true,
        value: {
          kind: "rpc",
          page: {
            messages: [],
            encodedResponse: {
              messages: new TextEncoder().encode(JSON.stringify(expected.messages)),
            },
          },
        },
      });
    } finally {
      worker.close(JSON.stringify([{ path }]));
    }
  });
});

it.for([
  { change: "newer schema", sql: "PRAGMA user_version = 999", error: undefined },
  {
    change: "missing table",
    sql: "DROP TABLE session_nodes",
    error: /Session metadata unavailable.*table-missing/,
  },
  {
    change: "ordinary commit",
    sql: "UPDATE schema_meta SET updated_at = updated_at + 1 WHERE meta_key = 'primary'",
    error: undefined,
  },
])(
  "keeps admitted format and observes row availability after a foreign $change",
  async ({ sql, error }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const options = { agentId: "main", env: state.env };
      const { path } = openOpenClawAgentDatabase(options);
      const sessionKey = "agent:main:main";
      replaceSessionEntrySync(
        { ...options, sessionKey },
        { sessionId: "retained-listing", updatedAt: 1 },
      );
      // The registered handler must use its real retained read-only scope, not a host writer.
      await closeOpenClawAgentDatabaseByPathAsync(path);
      const database = { agentId: "main", path };
      const request: SessionTranscriptWorkerInput = {
        kind: "session-entry-list",
        database,
        scope: { ...options, storePath: path, projection: "list" },
      };
      const expected = {
        ok: true,
        value: {
          kind: "session-entry-list",
          entries: [{ sessionKey, entry: { sessionId: "retained-listing" } }],
        },
      };
      const opens = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase");
      const countOpens = () => opens.mock.calls.filter(([filename]) => filename === path).length;
      // Foreign commits must be visible on the next read without a scheduled turn.
      // Native SQLite and the retained reader remain real.
      vi.useFakeTimers({ toFake: ["setImmediate"] });
      let pending: Promise<unknown> | undefined;
      try {
        await expect(worker.read({ kind: "prewarm", database, env: state.env })).resolves.toEqual({
          ok: true,
          value: { kind: "prewarm" },
        });
        expect(countOpens()).toBe(1);
        pending = worker.read(request);
        await expect(racePromiseWithAbortSignal(pending, signal)).resolves.toMatchObject(expected);
        expect(countOpens()).toBe(1);
        // A raw native peer reproduces a different worker/process: no local schema publication.
        const writer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(path);
        try {
          writer.exec(sql);
        } finally {
          writer.close();
        }

        pending = worker.read(request);
        const result = await racePromiseWithAbortSignal(pending, signal);
        if (error) {
          expect(result).toMatchObject({
            ok: false,
            error: { kind: "read-error", message: expect.stringMatching(error) },
          });
        } else {
          expect(result).toMatchObject(expected);
        }
        // The same retained reader handles the changed file.
        expect(countOpens()).toBe(1);
        if (!error) {
          const receipt = getOpenClawAgentDatabaseValidationForTransfer(database);
          assert(receipt);
          await applyAgentDatabaseReaderRequest({
            kind: "close",
            candidates: [{ path }],
            deleted: false,
          });
          worker.close(JSON.stringify([{ path }]));
          expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
          expect(Atomics.load(new Int32Array(receipt.valid), 0)).toBe(1);
          expect(Atomics.load(new Int32Array(receipt.canonicalReady), 0)).toBe(1);
        }
      } finally {
        vi.runOnlyPendingTimers();
        await Promise.allSettled([pending]);
        vi.useRealTimers();
        vi.restoreAllMocks();
        worker.close(JSON.stringify([{ path }]));
      }
    });
  },
);

it("transfers only owned artifact response bytes and leaves HEAD replies payload-free", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "main";
    const sessionKey = "agent:main:artifact-transfer";
    const sessionId = "artifact-transfer";
    const options = { agentId, env: state.env };
    const { path } = openOpenClawAgentDatabase(options);
    const scope = { ...options, sessionKey, sessionId, storePath: path };
    replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
    appendTranscriptMessageSync(scope, {
      eventId: "artifact-message",
      message: {
        role: "assistant",
        content: [{ type: "file", title: "bytes.bin", data: "AAECAwQFBgc=" }],
      },
    });
    await closeOpenClawAgentDatabaseByPathAsync(path);
    const read = async (query: SessionArtifactReadQuery) => {
      const reply = await worker.read({
        kind: "history-page",
        database: { agentId, path },
        request: { kind: "artifacts", params: { target: scope, query } },
        target: {
          transcript: { agentId, sessionId, sessionKey, storePath: path, sessionFile: sessionKey },
          entryValidationKey: sessionKey,
        },
      });
      assert(reply.ok);
      assert(
        typeof reply.value === "object" &&
          reply.value !== null &&
          "kind" in reply.value &&
          reply.value.kind === "artifacts",
      );
      return { reply, result: reply.value.result };
    };
    try {
      const listed = await read({ kind: "list", sessionKey, includeDownloadData: false });
      assert(listed.result.kind === "list");
      const artifactId = listed.result.artifacts[0]?.id;
      assert(artifactId);
      const grant = await read({ kind: "download-grant", sessionKey, artifactId });
      assert(grant.result.kind === "download-grant" && grant.result.selection?.kind === "prepared");
      const expectedDigest = grant.result.selection.download.digest;
      expect(worker.transfers(grant.reply)).toEqual([]);
      expect(grant.result.selection.download.artifact).not.toHaveProperty("data");

      for (const method of ["GET", "HEAD"] as const) {
        const { reply, result } = await read({
          kind: "download-response",
          sessionKey,
          artifactId,
          response: { expectedDigest, method, headers: { range: "bytes=1-4" } },
        });
        assert(result.kind === "download-response" && result.response);
        const transfers = worker.transfers(reply);
        if (method === "HEAD") {
          expect(result.response.response).toMatchObject({ kind: "full", contentLength: 8 });
          expect(result.response).not.toHaveProperty("body");
          expect(transfers).toEqual([]);
          continue;
        }
        const body = result.response.body;
        assert(body);
        expect(Array.from(body)).toEqual([1, 2, 3, 4]);
        expect(body.buffer.byteLength).toBe(4);
        expect(transfers).toEqual([body.buffer]);
        const received = structuredClone(reply, { transfer: transfers });
        expect(body.buffer.byteLength).toBe(0);
        expect(received).toMatchObject({
          ok: true,
          value: {
            kind: "artifacts",
            result: {
              kind: "download-response",
              response: { body: new Uint8Array([1, 2, 3, 4]) },
            },
          },
        });
      }
    } finally {
      worker.close(JSON.stringify([{ path }]));
    }
  });
});
