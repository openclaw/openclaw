import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import {
  closeOpenClawAgentDatabaseByPath,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createSessionEntryWithTranscript,
  loadSessionEntry,
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEventPage,
} from "./session-accessor.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { readCommittedTranscriptMessageSequence } from "./session-accessor.sqlite-transcript-sequences.js";
import {
  appendTranscriptEvent,
  replaceTranscriptEvents,
} from "./session-accessor.sqlite-transcript-write.js";
import { prepareSessionTranscriptProjection } from "./session-transcript-projection-rebuild.js";
import { createMemoryTranscriptProjectionSource } from "./session-transcript-reconcile-memory.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();
const agentId = "secondary";
const sessionId = "memory-reconcile";
const sessionKey = "agent:secondary:dashboard:incognito-reconcile";
const message = (id: string, content = id): TranscriptEvent => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "user", content },
});

describe("incognito transcript reconciliation", () => {
  let ambient: OpenClawTestState;
  let explicit: OpenClawTestState;

  beforeEach(async () => {
    ambient = await createOpenClawTestState({ prefix: "memory-reconcile-ambient-" });
    explicit = await createOpenClawTestState({
      prefix: "memory-reconcile-explicit-",
      applyEnv: false,
    });
  });

  afterEach(async () => {
    for (const state of [explicit, ambient]) {
      await waitForSessionTranscriptIndexReconcilesInStateDir(state.stateDir);
      closeOpenClawAgentDatabaseByPath(
        resolveIncognitoOpenClawAgentSqlitePath({ agentId, env: state.env }),
      );
      await state.cleanup();
    }
  });

  function target(env: NodeJS.ProcessEnv | undefined) {
    const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId, env });
    return {
      options: { agentId, env, path },
      scope: { agentId, env, sessionId, sessionKey, storePath: path },
    };
  }

  function expectNoDiskState() {
    expect(fs.readdirSync(ambient.stateDir, { recursive: true })).toEqual([]);
    expect(fs.readdirSync(explicit.stateDir, { recursive: true })).toEqual([]);
  }

  it.each(["ambient", "explicit"] as const)(
    "repairs a supported branch through the scheduled worker (%s environment)",
    async (environment) => {
      const { scope, options } = target(environment === "ambient" ? undefined : explicit.env);
      const turn = await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("root", null, { role: "user", content: "root" }),
          transcriptMessage("abandoned", "root", {
            role: "assistant",
            content: "🦞".repeat(262_144),
          }),
          transcriptMessage("active", "root", { role: "assistant", content: "active" }),
        ],
        touchSessionEntry: false,
      });
      expect.soft(turn.messages[0]?.anchor?.storePath).toBe(options.path);
      const rowCount = (env: NodeJS.ProcessEnv | undefined) => {
        const selected = target(env).options;
        return getOpenClawAgentDatabaseIfOpen(selected)
          ?.db.prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
          .get(sessionId);
      };
      expect.soft(rowCount(options.env)).toEqual({ count: 4 });
      if (environment === "explicit") {
        expect.soft(rowCount(ambient.env)).toBeUndefined();
      }
      await waitForSessionTranscriptIndexReconcile(options);
      const page = readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 });
      expect(page.events.map(({ event }) => event)).toEqual([
        expect.objectContaining({ id: "root", message: { role: "user", content: "root" } }),
        expect.objectContaining({
          id: "active",
          message: { role: "assistant", content: "active" },
        }),
      ]);
      const database = getOpenClawAgentDatabaseIfOpen(options)!;
      expect(
        database.db
          .prepare(
            "SELECT message_id, text FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id",
          )
          .all(sessionId),
      ).toEqual([
        { message_id: "active", text: "active" },
        { message_id: "root", text: "root" },
      ]);
      expectNoDiskState();
    },
    30_000,
  );

  it.each([false, true])(
    "transfers exact UTF-8 in bounded frames without retaining a transaction (ranged=%s)",
    async (ranged) => {
      const { scope, options } = target(explicit.env);
      const event = message("large", "🦞".repeat(131_073));
      await replaceTranscriptEvents(
        scope,
        ranged ? [message("excluded-before"), event, message("excluded-after")] : [event],
      );
      const database = openOpenClawAgentDatabase(options);
      const source = createMemoryTranscriptProjectionSource(
        database,
        options,
        ranged ? { afterSeq: 0, throughSeq: 1 } : undefined,
      );
      const bytes: Uint8Array[] = [];
      while (true) {
        const frame = source.read(sessionId);
        expect(database.db.isTransaction).toBe(false);
        if (frame.type === "source-end") {
          expect(frame.snapshot.maxSeq).toBe(ranged ? 1 : 0);
          break;
        }
        expect(frame.type).toBe("source-frame");
        if (frame.type !== "source-frame") {
          throw new Error("source unexpectedly unavailable");
        }
        expect(frame.seq).toBe(ranged ? 1 : 0);
        expect(frame.bytes.byteLength).toBeLessThanOrEqual(256 * 1024);
        bytes.push(frame.bytes);
        if (ranged && bytes.length === 1) {
          await appendTranscriptEvent(scope, { type: "metadata", id: "later-append" });
        }
      }
      expect(bytes.length).toBeGreaterThan(1);
      expect(JSON.parse(Buffer.concat(bytes).toString("utf8"))).toEqual(event);
      source.clear();
      expectNoDiskState();
    },
  );

  it("returns an empty captured range without reading later appends or a future prefix", async () => {
    const { scope, options } = target(explicit.env);
    await replaceTranscriptEvents(scope, [message("prefix")]);
    const database = openOpenClawAgentDatabase(options);
    const source = createMemoryTranscriptProjectionSource(database, options, {
      afterSeq: 0,
      throughSeq: 0,
    });
    expect(source.read(sessionId)).toMatchObject({ type: "source-end", snapshot: { maxSeq: 0 } });
    await appendTranscriptEvent(scope, { type: "metadata", id: "later-append" });
    expect(source.read(sessionId)).toMatchObject({ type: "source-end", snapshot: { maxSeq: 0 } });
    source.clear();
    const future = createMemoryTranscriptProjectionSource(database, options, {
      afterSeq: 1,
      throughSeq: 2,
    });
    expect(future.read(sessionId)).toEqual({ type: "source-unavailable" });
    future.clear();
    expectNoDiskState();
  });

  it("keeps scoped cursors and entry touching when the entry arrives during preparation", async () => {
    const { scope, options } = target(explicit.env);
    const entry = { incognito: true as const, sessionId, updatedAt: 1 };
    const result = await persistSessionTranscriptTurn(
      { ...scope, sessionEntry: entry },
      {
        messages: [
          {
            eventId: "scoped-message",
            message: { role: "user", content: "scoped content" },
            shouldAppend: async (context) => {
              expect(Object.keys(context).toSorted()).toEqual([
                "agentId",
                "sessionId",
                "sessionKey",
                "storePath",
              ]);
              await createSessionEntryWithTranscript(scope, () => ({ ok: true, entry }));
              return true;
            },
          },
        ],
        touchSessionEntry: true,
      },
    );
    expect(result.messages[0]?.anchor?.storePath).toBe(options.path);
    expect(readCommittedTranscriptMessageSequence(result.messages[0]!)).toBe(1);
    expect(loadSessionEntry(scope)?.updatedAt).toBeGreaterThan(1);
    expect(getOpenClawAgentDatabaseIfOpen(target(ambient.env).options)).toBeUndefined();
    expectNoDiskState();
  });

  it.each(
    (["append", "replace", "delete-recreate", "dispose", "reopen"] as const).flatMap((mutation) =>
      (mutation === "append" ? [false] : [false, true]).map((ranged) => ({ mutation, ranged })),
    ),
  )(
    "revokes a captured source after $mutation before another frame or plan is accepted (ranged=$ranged)",
    async ({ mutation, ranged }) => {
      const { scope, options } = target(explicit.env);
      await replaceTranscriptEvents(scope, [message("original", "x".repeat(300_000))]);
      const database = openOpenClawAgentDatabase(options);
      const source = createMemoryTranscriptProjectionSource(
        database,
        options,
        ranged ? { afterSeq: -1, throughSeq: 0 } : undefined,
      );
      const plan = prepareSessionTranscriptProjection(database.db, sessionId)!;
      expect(source.read(sessionId)).toMatchObject({ type: "source-frame", final: false });
      expect(source.isCurrentPlan(plan)).toBe(true);
      if (mutation === "dispose" || mutation === "reopen") {
        closeOpenClawAgentDatabaseByPath(database.path);
        if (mutation === "reopen") {
          await replaceTranscriptEvents(scope, [message("replacement")]);
        }
        expect(() => source.read(sessionId)).toThrow("disposed");
        expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(database);
        if (mutation === "dispose") {
          expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
        }
      } else {
        if (mutation === "append") {
          await appendTranscriptEvent(scope, { type: "metadata", id: "appended" });
        } else {
          if (mutation === "delete-recreate") {
            await replaceTranscriptEvents(scope, []);
          }
          await replaceTranscriptEvents(scope, [message("replacement")]);
        }
        expect(source.isCurrentPlan(plan)).toBe(false);
        expect(source.read(sessionId)).toEqual({ type: "source-unavailable" });
      }
      source.clear();
      expectNoDiskState();
    },
  );

  it.each(["direct", "scheduled"] as const)(
    "does not reopen an owner disposed before queued %s preflight",
    async (mode) => {
      const { scope, options } = target(explicit.env);
      await replaceTranscriptEvents(scope, [message("seed")]);
      const database = openOpenClawAgentDatabase(options);
      const blocked = createDeferred();
      const release = createDeferred();
      const blocker = runExclusiveSqliteSessionWrite(
        options,
        async () => {
          blocked.resolve();
          await release.promise;
        },
        "sessions.transcript-index.preflight",
      );
      await blocked.promise;
      let pending: Promise<unknown>;
      if (mode === "direct") {
        pending = reconcileSessionTranscriptIndexes(options);
      } else {
        startSessionTranscriptIndexReconcile(options);
        pending = waitForSessionTranscriptIndexReconcile(options);
      }
      const outcome = pending.then(
        () => "fulfilled",
        () => "rejected",
      );
      try {
        closeOpenClawAgentDatabaseByPath(database.path);
        if (mode === "scheduled") {
          await waitForSessionTranscriptProjection(scope);
        }
      } finally {
        release.resolve();
        await blocker;
      }
      const result = await outcome;
      expect(database.db.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(result).toBe(mode === "direct" ? "rejected" : "fulfilled");
      expectNoDiskState();
    },
  );

  it.each(["plan-start", "active-chunk", "fts-chunk", "plan-finish", "pending"] as const)(
    "joins a queued %s before finishing disposal without reopening state",
    async (stage) => {
      const { scope, options } = target(explicit.env);
      await replaceTranscriptEvents(scope, [message("seed")]);
      const database = openOpenClawAgentDatabase(options);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(sessionId);
      const blocked = createDeferred();
      const release = createDeferred();
      let blocker: Promise<void> | undefined;
      let worker: Worker | undefined;
      const params = options;
      observer.onTask = ({ worker: created, observeMessage }) => {
        worker = created;
        observeMessage((workerMessage: { type: string }) => {
          if (workerMessage.type === (stage === "pending" ? "active-chunk" : stage) && !blocker) {
            if (stage === "pending") {
              startSessionTranscriptIndexReconcile(params);
            }
            // Enter the real FIFO ahead of the owner handler, then dispose
            // immediately before its queued write could acquire a database.
            blocker = runExclusiveSqliteSessionWrite(
              options,
              async () => {
                blocked.resolve();
                await release.promise;
                closeOpenClawAgentDatabaseByPath(database.path);
              },
              "sessions.transcript-index.preflight",
            );
          }
        });
      };
      let pending: Promise<unknown>;
      if (stage === "pending") {
        startSessionTranscriptIndexReconcile(params);
        pending = waitForSessionTranscriptIndexReconcile(options);
      } else {
        pending = reconcileSessionTranscriptIndexes(params);
      }
      const outcome = pending.then(
        () => "fulfilled",
        () => "rejected",
      );
      try {
        await withTestTimeout(blocked.promise, 10_000, "memory worker did not reach writer fence");
      } finally {
        release.resolve();
        await blocker;
        await outcome;
      }
      expect(await outcome).toBe(stage === "pending" ? "fulfilled" : "rejected");
      expect(worker?.threadId).toBe(-1);
      expect(database.db.isOpen).toBe(false);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expectNoDiskState();
    },
    20_000,
  );

  it("joins the final memory sweep after the pooled task completes", async () => {
    const { scope, options } = target(explicit.env);
    await replaceTranscriptEvents(scope, [message("seed")]);
    const database = openOpenClawAgentDatabase(options);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const blocked = createDeferred();
    const release = createDeferred();
    const completed = createDeferred();
    let blocker: Promise<void> | undefined;
    let worker: Worker | undefined;
    let settled = false;
    observer.onTask = ({ worker: created, taskId, observeMessage }) => {
      worker = created;
      worker.on("message", (reply: { taskId: number; status: string }) => {
        if (reply.taskId === taskId && reply.status === "ok") {
          completed.resolve();
        }
      });
      observeMessage((workerMessage: { type: string }) => {
        if (workerMessage.type === "done") {
          // Memory's port can close while its final parent write waits in the FIFO.
          blocker = runExclusiveSqliteSessionWrite(
            options,
            async () => {
              blocked.resolve();
              await release.promise;
            },
            "sessions.transcript-index.preflight",
          );
        }
      });
    };
    const outcome = reconcileSessionTranscriptIndexes(options).then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await withTestTimeout(blocked.promise, 10_000, "memory final sweep did not reach its fence");
      await withTestTimeout(completed.promise, 10_000, "memory task did not complete");
      expect(worker?.threadId).toBeGreaterThan(0);
      expect(settled).toBe(false);
    } finally {
      release.resolve();
      await blocker;
      await outcome;
    }
    expect(await outcome).toEqual({ value: { reconciledSessions: 1 } });
    expectNoDiskState();
  }, 20_000);

  it("hands a successor's scheduled work over after successful old-owner settlement", async () => {
    const { scope, options } = target(ambient.env);
    await replaceTranscriptEvents(scope, [message("old-owner")]);
    const database = openOpenClawAgentDatabase(options);
    const state = () =>
      getOpenClawAgentDatabaseIfOpen(options)
        ?.db.prepare(
          "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(sessionId);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(sessionId);
    const joined = createDeferred();
    const workers = new Set<Worker>();
    let tasks = 0;
    let finishPrevious: (() => void) | undefined;
    observer.onTask = ({ worker, taskId }) => {
      workers.add(worker);
      tasks += 1;
      if (tasks === 1) {
        const emit = worker.emit.bind(worker);
        worker.emit = (...args: Parameters<typeof emit>) => {
          const [event, reply] = args;
          if (
            event === "message" &&
            isRecord(reply) &&
            reply.taskId === taskId &&
            reply.status === "ok"
          ) {
            finishPrevious = () => {
              emit(...args);
            };
            joined.resolve();
            return true;
          }
          return emit(...args);
        };
      }
    };
    startSessionTranscriptIndexReconcile(options);
    const pending = waitForSessionTranscriptIndexReconcile(options);
    try {
      await withTestTimeout(joined.promise, 10_000, "old memory worker did not settle");
      expect(state()).toEqual({ needs_rebuild: 0 });
      await runExclusiveSqliteSessionWrite(
        options,
        async () => undefined,
        "sessions.transcript-index.preflight",
      );
      expect([...workers][0]?.threadId).toBeGreaterThan(0);
      closeOpenClawAgentDatabaseByPath(database.path);
      await persistSessionTranscriptTurn(scope, {
        messages: [
          transcriptMessage("root", null, { role: "user", content: "root" }),
          transcriptMessage("abandoned", "root", { role: "assistant", content: "abandoned" }),
          transcriptMessage("active", "root", { role: "assistant", content: "active" }),
        ],
        touchSessionEntry: false,
      });
      expect(getOpenClawAgentDatabaseIfOpen(options)).not.toBe(database);
      expect(state()).toEqual({ needs_rebuild: 1 });
    } finally {
      finishPrevious?.();
      await pending;
    }
    expect(state()).toEqual({ needs_rebuild: 0 });
    expect(
      readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
        ({ event }) => event,
      ),
    ).toEqual([expect.objectContaining({ id: "root" }), expect.objectContaining({ id: "active" })]);
    expect(tasks).toBe(2);
    expect(workers.size).toBe(1);
    expect([...workers][0]?.threadId).toBeGreaterThan(0);
    expectNoDiskState();
  }, 20_000);
});
