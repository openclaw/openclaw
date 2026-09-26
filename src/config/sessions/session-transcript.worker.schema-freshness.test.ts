import assert from "node:assert/strict";
import type { Transferable } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import type { SessionArtifactReadQuery } from "../../gateway/session-artifact-read.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import type { UsageCostWorkerReply } from "../../infra/session-cost-usage-worker.types.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";
import type {
  SessionTranscriptWorkerInput,
  SessionTranscriptWorkerReply,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";

type WorkerReply =
  | SessionTranscriptWorkerReply<keyof SessionTranscriptWorkerValues>
  | UsageCostWorkerReply;

const worker = vi.hoisted(() => ({
  read: vi.fn<(input: SessionTranscriptWorkerInput) => Promise<WorkerReply>>(),
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

it.for([
  { change: "newer schema", sql: "PRAGMA user_version = 999", error: /newer schema version/ },
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
  "revalidates a warm worker listing after a foreign $change",
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
        // Refresh the retained admission, rather than hiding the bug with a cold reader.
        expect(countOpens()).toBe(1);
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
