import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import type { Transferable } from "node:worker_threads";
import { constants as zlibConstants, inflateRawSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { prepareChatHistoryResponsePage } from "../../gateway/chat-history-response-page.js";
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
import { captureOpenClawStateReadWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import type { ChatHistoryPageParams } from "./session-history-types.js";
import { withTranscriptDatabase } from "./session-transcript-fixture.test-support.js";
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
  heap: undefined as { used_heap_size: number; heap_size_limit: number } | undefined,
}));
vi.mock("node:v8", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:v8")>();
  return {
    ...actual,
    getHeapStatistics: () => ({ ...actual.getHeapStatistics(), ...worker.heap }),
  };
});
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

type Fixture = Parameters<Parameters<typeof withTranscriptDatabase>[1]>[0];

function withWorker(sessionId: string, run: (fixture: Fixture) => Promise<void>) {
  return withTranscriptDatabase(sessionId, async (fixture) => {
    replaceSessionEntrySync(fixture.scope, { sessionId, updatedAt: 1 });
    try {
      await run(fixture);
    } finally {
      worker.close(JSON.stringify([{ path: fixture.database.path }]));
    }
  });
}

function historyTarget({ agentId, sessionId, sessionKey, storePath }: Fixture["scope"]) {
  return {
    transcript: { agentId, sessionId, sessionKey, storePath, sessionFile: sessionKey },
    entryValidationKey: sessionKey,
  };
}

function historyValue(reply: WorkerReply) {
  assert(reply.ok && typeof reply.value === "object" && reply.value !== null);
  assert("kind" in reply.value && (reply.value.kind === "rpc" || reply.value.kind === "artifacts"));
  return reply.value;
}

it("sheds isolate-local caches at eighty percent of the actual worker heap limit", async () => {
  await withWorker("heap-pressure", async ({ database: opened }) => {
    const pressure = channel("openclaw.memory.critical");
    const shed = vi.fn();
    pressure.subscribe(shed);
    const request = {
      kind: "prewarm" as const,
      database: { agentId: opened.agentId, path: opened.path },
      env: {},
    };
    try {
      worker.heap = { used_heap_size: 799, heap_size_limit: 1000 };
      await expect(worker.read(request)).resolves.toMatchObject({ ok: true });
      expect(shed).not.toHaveBeenCalled();
      worker.heap.used_heap_size = 800;
      await expect(worker.read(request)).resolves.toMatchObject({ ok: true });
      expect(shed).toHaveBeenCalledTimes(process.versions.bun ? 0 : 1);
      worker.heap.heap_size_limit = 2000;
      await expect(worker.read(request)).resolves.toMatchObject({ ok: true });
      expect(shed).toHaveBeenCalledTimes(process.versions.bun ? 0 : 1);
    } finally {
      worker.heap = undefined;
      pressure.unsubscribe(shed);
    }
  });
});

it("borrows canonical writer proof without a native reader and still fences foreign changes", async () => {
  await withWorker("writer-proof", async ({ database: opened, scope }) => {
    const database = { agentId: opened.agentId, path: opened.path };
    const { sessionKey } = scope;
    const retained = getOpenClawAgentDatabaseValidationForTransfer(database);
    assert(retained);
    const { agentId, identity, birthtime, receiptId, valid, canonicalReady } = retained;
    const validation = { agentId, identity, birthtime, receiptId, valid, canonicalReady };
    await closeOpenClawAgentDatabaseByPathAsync(database.path);
    // A reader worker starts without the writer's process-local validation metadata.
    releaseOpenClawAgentDatabaseReadValidation([{ path: database.path }]);
    expect(getOpenClawAgentDatabaseValidationForTransfer(database)).toBeUndefined();
    const request = {
      kind: "session-entry-read" as const,
      database,
      scope: { ...scope, databaseAgentId: "main" },
      validation,
    };
    const observation = observeSqliteReadSql(
      nodeSqlite.requireNodeSqlite().StatementSync.prototype,
    );
    using reads = { ...observation, [Symbol.dispose]: observation.restore };
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
    {
      using peer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(database.path);
      const relabel =
        "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?";
      peer.prepare(relabel).run("foreign label", sessionKey);
    }
    await expect(worker.read(request)).resolves.toMatchObject({
      ok: true,
      value: { kind: "session-entry-read", entry: { label: "foreign label" } },
    });
    const denied = {
      ok: false,
      error: { kind: "read-error", message: expect.stringContaining("validation") },
    };
    await expect(
      worker.read({
        ...request,
        validation: { ...validation, identity: "different-generation" },
      }),
    ).resolves.toMatchObject(denied);
    await expect(worker.read(request)).resolves.toMatchObject({ ok: true });
    Atomics.store(new Int32Array(validation.valid), 0, 0);
    await expect(worker.read(request)).resolves.toMatchObject(denied);
  });
});

it("reads the latest projection status with one SELECT and no transaction envelope", async () => {
  await withWorker("projection-status", async ({ state, database, scope }) => {
    appendTranscriptMessageSync(scope, {
      eventId: "projection-message",
      message: { role: "assistant", content: [{ type: "text", text: "Synthetic projection" }] },
    });
    const request = {
      kind: "projection-status" as const,
      database: { agentId: database.agentId, path: database.path },
      env: state.env,
      sessionId: scope.sessionId,
    };
    await expect(worker.read(request)).resolves.toMatchObject({ ok: true, value: false });
    const update = database.db.prepare(
      "UPDATE session_transcript_index_state SET needs_rebuild = ? WHERE session_id = ?",
    );
    const native = nodeSqlite.requireNodeSqlite();
    const observation = observeSqliteReadSql(native.StatementSync.prototype);
    using reads = { ...observation, [Symbol.dispose]: observation.restore };
    using exec = vi.spyOn(native.DatabaseSync.prototype, "exec");
    for (const needsReconcile of [false, true, false]) {
      update.run(Number(needsReconcile), scope.sessionId);
      reads.queries.length = 0;
      exec.mockClear();
      await expect(worker.read(request)).resolves.toMatchObject({
        ok: true,
        value: needsReconcile,
      });
      expect(reads.queries).toEqual([expect.stringMatching(/^\s*select\b/i)]);
      expect(
        exec.mock.calls.filter(([sql]) => /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)),
      ).toEqual([]);
    }
  });
});

it.for([
  { offset: 0, maxHistoryBytes: 1024, messageBytes: 200_000 },
  { offset: 1, maxHistoryBytes: 1024, messageBytes: 200_000 },
  { offset: 0, maxHistoryBytes: 256 * 1024, messageBytes: 64 * 1024 },
])(
  "transfers bounded history JSON at offset $offset (budget $maxHistoryBytes) without retaining worker buffers",
  async ({ offset, maxHistoryBytes, messageBytes }) => {
    await withWorker("history-transfer", async ({ state, database, scope }) => {
      const { agentId, sessionKey, sessionId } = scope;
      const { path } = database;
      for (const [index, length] of [64, messageBytes].entries()) {
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
        maxHistoryBytes,
        effectiveMaxChars: 300_000,
        offset,
        messageId: undefined,
      };
      const read = async (encodeResponse: boolean) => {
        const reply = await worker.read({
          kind: "history-page",
          database: { agentId, path },
          request: { kind: "rpc", params: { ...params, encodeResponse, deflateResponse: true } },
          target: {
            ...historyTarget(scope),
            stateDatabase: {
              path: stateContext.admission.databasePath,
              environment: stateContext.environment,
            },
          },
        });
        const value = historyValue(reply);
        assert(value.kind === "rpc");
        return { reply, page: value.page };
      };
      const ordinary = await read(false);
      expect(ordinary.page.pagination).toMatchObject({ offset, totalMessages: 2 });
      const expected = prepareChatHistoryResponsePage(ordinary.page, params);
      const { reply, page } = await read(true);
      const body = page.encodedResponse?.messages;
      assert(body);
      expect(body.byteLength).toBeLessThanOrEqual(params.maxHistoryBytes);
      expect(JSON.parse(new TextDecoder().decode(body))).toEqual(expected.messages);
      expect([page.pagination, page.anchor]).toEqual([undefined, undefined]);
      expect(Object.hasOwn(page, "activeLeafEntryId")).toBe(offset === 0);
      expect(page.encodedResponse?.totalMessages).toBe(2);
      expect(page.encodedResponse?.nextOffset).toBe(expected.nextOffset);
      expect(page.encodedResponse?.hasMore).toBe(expected.hasMore);
      const deflated = page.encodedMessagesDeflate;
      if (body.byteLength >= 4 * 1024) {
        assert(deflated);
        expect(inflateRawSync(deflated, { finishFlush: zlibConstants.Z_SYNC_FLUSH })).toEqual(
          Buffer.from(body),
        );
      } else {
        expect(deflated).toBeUndefined();
      }
      const received = structuredClone(reply, { transfer: worker.transfers(reply) });
      expect(body.byteLength).toBe(0);
      if (deflated) {
        expect(deflated.byteLength).toBe(0);
      }
      expect(historyValue(received)).toMatchObject({
        kind: "rpc",
        page: {
          messages: [],
          encodedResponse: {
            messages: new TextEncoder().encode(JSON.stringify(expected.messages)),
          },
        },
      });
    });
  },
);

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
    await withWorker("retained-listing", async ({ state, database: opened, scope }) => {
      const { path } = opened;
      const database = { agentId: opened.agentId, path };
      const { sessionKey } = scope;
      // The registered handler must use its real retained read-only scope, not a host writer.
      await closeOpenClawAgentDatabaseByPathAsync(path);
      const request: SessionTranscriptWorkerInput = {
        kind: "session-entry-list",
        database,
        scope: { agentId: "main", env: state.env, storePath: path, projection: "list" },
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
        {
          using writer = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(path);
          writer.exec(sql);
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
      }
    });
  },
);

it("transfers only owned artifact response bytes and leaves HEAD replies payload-free", async () => {
  await withWorker("artifact-transfer", async ({ database, scope }) => {
    const { agentId, sessionKey } = scope;
    const { path } = database;
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
        target: historyTarget(scope),
      });
      const value = historyValue(reply);
      assert(value.kind === "artifacts");
      return { reply, result: value.result };
    };
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
      expect(historyValue(received)).toMatchObject({
        kind: "artifacts",
        result: {
          kind: "download-response",
          response: { body: new Uint8Array([1, 2, 3, 4]) },
        },
      });
    }
  });
});
