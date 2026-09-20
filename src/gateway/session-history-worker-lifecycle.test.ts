import fs from "node:fs";
import path from "node:path";
import type { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import {
  prepareSessionEntryPresenceRead,
  withSessionHistoryWorkerDatabase,
} from "../config/sessions/session-transcript-worker-runtime.js";
import { DEFAULT_WORKER_PENDING_BYTES } from "../infra/worker-task-capacity.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.paths.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";
import { readChatHistoryMessageId } from "./session-history-tail.js";

const observed = vi.hoisted(() => ({
  timers: vi.spyOn(globalThis, "setTimeout"),
  workers: [] as Worker[],
  dispatch: undefined as ((message: unknown) => void) | undefined,
  restoration: undefined as
    | { sessionId: string; entered: () => void; wait: Promise<void> }
    | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      override postMessage(...args: Parameters<Worker["postMessage"]>): void {
        const kind = asOptionalRecord(asOptionalRecord(args[0])?.input)?.kind;
        if (
          (kind === "history-page" || kind === "session-row-presence") &&
          !observed.workers.includes(this)
        ) {
          observed.workers.push(this);
        }
        observed.dispatch?.(args[0]);
        super.postMessage(...args);
      }
    },
  };
});
vi.mock("../config/sessions/session-cold-storage-read.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-cold-storage-read.js")>();
  return {
    ...actual,
    readRestoredSessionTranscript: async (
      ...args: Parameters<typeof actual.readRestoredSessionTranscript>
    ) => {
      const held = observed.restoration;
      if (args[0].sessionId === held?.sessionId) {
        held.entered();
        await held.wait;
      }
      return actual.readRestoredSessionTranscript(...args);
    },
  };
});

afterAll(() => observed.timers.mockRestore());

afterEach(() => {
  observed.dispatch = undefined;
  observed.restoration = undefined;
  for (const worker of observed.workers.splice(0)) {
    expect(worker.threadId).toBe(-1);
  }
});

it.each([false, true])(
  "reads exact row presence without creating a database (incognito=%s)",
  async (incognito) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-presence"
          : "agent:main:dashboard:presence",
        storePath: path.join(state.agentDir(), "presence.sqlite"),
        env: state.env,
      };
      const databasePath = incognito
        ? resolveIncognitoOpenClawAgentSqlitePath(target)
        : target.storePath;
      const { read } = prepareSessionEntryPresenceRead(target);
      const workersBefore = observed.workers.length;
      expect(await read()).toBe(false);
      expect(fs.existsSync(databasePath)).toBe(false);
      await replaceSessionEntry(target, { sessionId: "metadata-without-transcript", updatedAt: 1 });
      expect(await read()).toBe(true);
      expect(
        await prepareSessionEntryPresenceRead({
          ...target,
          sessionKey: target.sessionKey.toUpperCase(),
        }).read(),
      ).toBe(true);
      expect(
        await prepareSessionEntryPresenceRead({
          ...target,
          sessionKey: `${target.sessionKey}-sibling`,
        }).read(),
      ).toBe(false);
      if (incognito) {
        expect(observed.workers).toHaveLength(workersBefore);
        expect(fs.existsSync(databasePath)).toBe(false);
      } else {
        expect(observed.workers.length).toBeGreaterThan(workersBefore);
      }
    });
  },
);

it("retains the prepared metadata target when caller scope and environment change", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:captured-presence",
      storePath: path.join(state.agentDir(), "captured.sqlite"),
      env: { ...state.env },
    };
    await replaceSessionEntry(target, { sessionId: "captured-row", updatedAt: 1 });
    const { read } = prepareSessionEntryPresenceRead(target);
    target.storePath = path.join(state.agentDir(), "replacement.sqlite");
    target.env.OPENCLAW_STATE_DIR = state.path("different-state");
    expect(await read()).toBe(true);
    expect(await prepareSessionEntryPresenceRead(target).read()).toBe(false);
    expect(fs.existsSync(target.storePath)).toBe(false);
  });
});

it("joins native worker exit when metadata-read custody is revoked during dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:revoked-presence",
      storePath: path.join(state.agentDir(), "revoked.sqlite"),
      env: state.env,
    };
    await replaceSessionEntry(target, { sessionId: "revoked-row", updatedAt: 1 });
    let closing: Promise<boolean> | undefined;
    observed.dispatch = (message) => {
      if (asOptionalRecord(asOptionalRecord(message)?.input)?.kind === "session-row-presence") {
        observed.dispatch = undefined;
        closing = closeOpenClawAgentDatabaseByPathAsync(target.storePath, target.agentId);
      }
    };
    await expect(prepareSessionEntryPresenceRead(target).read()).rejects.toThrow("revoked");
    expect(closing).toBeDefined();
    await closing;
    expect(observed.workers.at(-1)?.threadId).toBe(-1);
  });
});

async function seed(state: OpenClawTestState, agentId: string, sessionId: string) {
  const target = {
    agentId,
    sessionId,
    sessionKey: `agent:${agentId}:${sessionId}`,
    storePath: path.join(state.sessionsDir(agentId), "sessions.json"),
  };
  const entry = { sessionId, updatedAt: 1 };
  await replaceSessionEntry(target, entry);
  await replaceTranscriptEvents(target, [
    { type: "session", version: 3, id: sessionId },
    {
      type: "message",
      id: `${sessionId}-message`,
      parentId: null,
      message: { role: "user", content: sessionId },
    },
  ]);
  await waitForSessionTranscriptProjection(target);
  const params = {
    entry,
    provider: undefined,
    sessionId,
    storePath: target.storePath,
    sessionAgentId: agentId,
    canonicalKey: target.sessionKey,
    max: 20,
    maxHistoryBytes: 100_000,
    effectiveMaxChars: 8000,
    offset: undefined,
    messageId: undefined,
  };
  return {
    path: resolveOpenClawAgentSqlitePath({ agentId, env: state.env }),
    read: () => readChatHistoryPage(params),
  };
}

it("closes A through native exit while active and queued B pages survive, then reopens replaced A", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const a = await seed(state, "main", "close-a");
    const b = await seed(state, "other", "active-b");
    const c = await seed(state, "other", "queued-b");
    await a.read();
    await b.read();
    const oldWorker = observed.workers.at(-1)!;
    let closing: Promise<boolean> | undefined;
    observed.dispatch = (message) => {
      const input = asOptionalRecord(asOptionalRecord(message)?.input);
      const params = asOptionalRecord(asOptionalRecord(input?.request)?.params);
      if (params?.sessionId === "active-b") {
        observed.dispatch = undefined;
        closing = closeOpenClawAgentDatabaseByPathAsync(a.path, "main");
      }
    };
    const results = await Promise.all([b.read(), c.read()]);
    expect(closing).toBeDefined();
    await closing;
    expect(results.map((page) => page.messages.map(readChatHistoryMessageId))).toEqual([
      ["active-b-message"],
      ["queued-b-message"],
    ]);
    expect(oldWorker.threadId).toBe(-1);
    // This also exercises Windows replacement while the unrelated agent remains usable.
    fs.copyFileSync(a.path, `${a.path}.replacement`);
    fs.renameSync(a.path, `${a.path}.previous`);
    fs.renameSync(`${a.path}.replacement`, a.path);
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual(["close-a-message"]);
    expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual(["active-b-message"]);
  });
});

it("evicts the least recently used of 64 retained targets without charging missing databases", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const targets = [];
    for (let index = 0; index < 65; index++) {
      targets.push(await seed(state, `retained-${index}`, `history-${index}`));
    }
    for (const target of targets.slice(0, 64)) {
      await target.read();
    }
    await targets[0]!.read();
    const worker = observed.workers.at(-1)!;
    const threadId = worker.threadId;
    for (let index = 0; index < 65; index++) {
      const target = {
        agentId: `missing-${index}`,
        sessionKey: `agent:missing-${index}:absent`,
        storePath: state.statePath(`missing-${index}.sqlite`),
        env: state.env,
      };
      expect(await prepareSessionEntryPresenceRead(target).read()).toBe(false);
      expect(fs.existsSync(target.storePath)).toBe(false);
    }
    await targets[64]!.read();
    // Only the confirmed eviction releases custody without retiring this worker.
    await closeOpenClawAgentDatabaseByPathAsync(targets[1]!.path, "retained-1");
    expect(worker.threadId).toBe(threadId);
    await closeOpenClawAgentDatabaseByPathAsync(targets[0]!.path, "retained-0");
    expect(worker.threadId).toBe(-1);
    expect((await targets[64]!.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "history-64-message",
    ]);
  });
});

it("rejects the captured generation when A closes during restoration before worker admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const a = await seed(state, "main", "restoring-a");
    const b = await seed(state, "other", "unrelated-b");
    await b.read();
    const entered = createDeferredCore();
    const gate = createDeferredCore();
    observed.restoration = {
      sessionId: "restoring-a",
      entered: entered.resolve,
      wait: gate.promise,
    };
    const pending = a.read();
    const failure = expect(pending).rejects.toThrow("revoked");
    try {
      await entered.promise;
      await closeOpenClawAgentDatabaseByPathAsync(a.path, "main");
      expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual([
        "unrelated-b-message",
      ]);
    } finally {
      observed.restoration = undefined;
      gate.resolve();
    }
    await failure;
    expect((await a.read()).messages.map(readChatHistoryMessageId)).toEqual([
      "restoring-a-message",
    ]);
  });
});

it.each(["before restoration", "queued restoration"])(
  "does not restore a replacement database for a revoked history read (%s)",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const fixture = await createSessionColdStorageFixture(databasePath);
      expect(
        await runSessionColdStorageMaintenance({ config: maintenanceConfig(databasePath) }),
      ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
      const readStoredTranscript = () =>
        withOpenClawAgentDatabaseReadOnly(
          ({ db }) => ({
            cold: readSessionColdTranscript(db, fixture.scope.sessionId),
            events: db
              .prepare("SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq")
              .all(fixture.scope.sessionId),
          }),
          fixture.options,
        );
      const before = readStoredTranscript();
      expect(before).toEqual({
        found: true,
        value: {
          cold: expect.objectContaining({ session_id: fixture.scope.sessionId }),
          events: [],
        },
      });
      const entered = createDeferredCore();
      const gate = createDeferredCore();
      if (phase === "before restoration") {
        observed.restoration = {
          sessionId: fixture.scope.sessionId,
          entered: entered.resolve,
          wait: gate.promise,
        };
      }
      let pauseQueue = phase === "queued restoration";
      // oxlint-disable-next-line typescript/unbound-method -- The observer preserves the queue receiver.
      const enqueue = KeyedAsyncQueue.prototype.enqueue;
      const queueObservation = vi
        .spyOn(KeyedAsyncQueue.prototype, "enqueue")
        .mockImplementation(function <T>(
          this: KeyedAsyncQueue,
          ...args: Parameters<typeof enqueue<T>>
        ): Promise<T> {
          const enqueueTask = enqueue<T>;
          const [key, task, hooks] = args;
          if (key !== databasePath || !pauseQueue) {
            return enqueueTask.call(this, ...args);
          }
          pauseQueue = false;
          return enqueueTask.call(
            this,
            key,
            async () => {
              entered.resolve();
              await gate.promise;
              return await task();
            },
            hooks,
          );
        });
      const pending = readChatHistoryPage({
        entry: undefined,
        provider: undefined,
        sessionId: fixture.scope.sessionId,
        storePath: databasePath,
        sessionAgentId: fixture.scope.agentId,
        canonicalKey: fixture.scope.sessionKey,
        max: 20,
        maxHistoryBytes: 100_000,
        effectiveMaxChars: 8000,
        offset: undefined,
        messageId: undefined,
      });
      const failure = expect(pending).rejects.toThrow("revoked");
      try {
        await entered.promise;
        await closeOpenClawAgentDatabaseByPathAsync(databasePath, "main");
        fs.copyFileSync(databasePath, `${databasePath}.replacement`);
        fs.renameSync(databasePath, `${databasePath}.previous`);
        fs.renameSync(`${databasePath}.replacement`, databasePath);
        expect(readStoredTranscript()).toEqual(before);
      } finally {
        queueObservation.mockRestore();
        observed.restoration = undefined;
        gate.resolve();
        await failure;
      }
      expect(readStoredTranscript()).toEqual(before);
    });
  },
);

it("leaves the unrelated warm worker running when admission rejects a request before dispatch", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const b = await seed(state, "other", "overload-b");
    await b.read();
    const worker = observed.workers.at(-1)!;
    const threadId = worker.threadId;
    await expect(
      withSessionHistoryWorkerDatabase(
        {
          agentId: "main",
          path: resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
        },
        (owner) =>
          owner.run(() => {
            throw new Error("refused factory must not run");
          }, DEFAULT_WORKER_PENDING_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: "overloaded" });
    expect(worker.threadId).toBe(threadId);
    expect((await b.read()).messages.map(readChatHistoryMessageId)).toEqual(["overload-b-message"]);
    expect(observed.workers.at(-1)).toBe(worker);
  });
});

it.each([false, true])(
  "joins the history worker when its 30-minute idle timer fires (missing=%s)",
  async (missing) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const a = missing
        ? prepareSessionEntryPresenceRead({
            agentId: "main",
            sessionKey: "agent:main:idle-missing",
            storePath: state.statePath("idle-missing.sqlite"),
            env: state.env,
          })
        : await seed(state, "main", "idle-a");
      const beforeRead = observed.timers.mock.calls.length;
      await a.read();
      const worker = observed.workers.at(-1)!;
      const index = observed.timers.mock.calls.findLastIndex((call) => call[1] === 30 * 60_000);
      expect(index).toBeGreaterThanOrEqual(beforeRead);
      const [expire] = observed.timers.mock.calls[index]!;
      const timer = observed.timers.mock.results[index]!.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);
      clearTimeout(timer);
      expire();
      await expect.poll(() => worker.threadId).toBe(-1);
      const reopened = await a.read();
      if (typeof reopened === "boolean") {
        expect(reopened).toBe(false);
      } else {
        expect(reopened.messages.map(readChatHistoryMessageId)).toEqual(["idle-a-message"]);
      }
      expect(observed.workers.at(-1)).not.toBe(worker);
      if (missing) {
        // No database resource exists to close; the reopened empty worker owns only its idle timer.
        const emptyWorker = observed.workers.at(-1)!;
        const nextIndex = observed.timers.mock.calls.findLastIndex(
          (call) => call[1] === 30 * 60_000,
        );
        expect(nextIndex).toBeGreaterThan(index);
        clearTimeout(observed.timers.mock.results[nextIndex]!.value as NodeJS.Timeout);
        observed.timers.mock.calls[nextIndex]![0]();
        await expect.poll(() => emptyWorker.threadId).toBe(-1);
        expect(observed.timers.mock.calls.filter((call) => call[1] === 30 * 60_000)).toHaveLength(
          observed.timers.mock.calls
            .slice(0, nextIndex + 1)
            .filter((call) => call[1] === 30 * 60_000).length,
        );
      }
    });
  },
);
