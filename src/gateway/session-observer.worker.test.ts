import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import { createSessionObserver } from "./session-observer.js";
import { event, modelMessage, preparedModel } from "./session-observer.test-utils.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";
import * as sessionReads from "./session-utils-store-lookup.js";

const key = "agent:main:session-1";

function interceptNextEntryRead(afterRead: () => void | Promise<void>) {
  const createReaders = historyReaders.createSessionHistoryWorkerReaders;
  let intercepted = false;
  vi.spyOn(historyReaders, "createSessionHistoryWorkerReaders").mockImplementation((runRequest) => {
    const readers = createReaders(runRequest);
    return {
      ...readers,
      readExactEntries: async (...args) => {
        const result = await readers.readExactEntries(...args);
        if (!intercepted) {
          intercepted = true;
          await afterRead();
        }
        return result;
      },
    };
  });
}

async function withObserver(
  run: (fixture: {
    observer: ReturnType<typeof createSessionObserver>;
    broadcast: ReturnType<typeof vi.fn>;
    persisted: ReturnType<typeof vi.fn>;
    peer: DatabaseSync;
    replaceStore: () => Promise<void>;
    rewriteLifecycle: () => void;
    rewriteLifecycleWithoutPublication: () => void;
    resetLifecycle: () => Promise<void>;
    closeDatabase: () => ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync>;
    advanceClock: () => void;
    watch: (enabled: boolean) => void;
    enableModel: () => void;
    finalized: Promise<void>;
  }) => Promise<void>,
  persistDigests = false,
) {
  await withOpenClawTestState({ label: "observer-worker" }, async ({ env, path }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    writeSessionEntry(database, key, {
      sessionId: "session-id",
      lifecycleRevision: "life-a",
      updatedAt: 1,
    });
    const peer = new DatabaseSync(database.path);
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("viewer", key)?.commit();
    const broadcast = vi.fn();
    const finalized = createDeferredCore();
    const persisted = vi.fn(
      async (params: Parameters<NonNullable<SessionObserverDeps["persistDigest"]>>[0]) => {
        if (params.digest.health === "done") {
          finalized.resolve();
        }
        return true;
      },
    );
    let utilityModelRef: string | undefined;
    let now = 1_000;
    const cfg = { session: { store: database.path } };
    const observer = createSessionObserver({
      getConfig: () => cfg,
      now: () => now,
      subscribers,
      broadcastToConnIds: broadcast,
      ...(persistDigests ? {} : { persistDigest: persisted }),
      resolveUtilityModelRef: () => utilityModelRef,
      prepareModel: async () => preparedModel(),
      completeModel: async () =>
        modelMessage({ headline: "Completed observation", health: "done" }),
    });
    observer.setConnectionVisibility("viewer", true);
    try {
      await run({
        observer,
        broadcast,
        persisted,
        peer,
        finalized: finalized.promise,
        rewriteLifecycle: () => {
          writeSessionEntry(database, key, {
            sessionId: "session-id",
            lifecycleRevision: "life-b",
            updatedAt: 2,
          });
        },
        rewriteLifecycleWithoutPublication: () => {
          database.db
            .prepare(
              "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', 'life-b') WHERE session_key = ?",
            )
            .run(key);
        },
        resetLifecycle: async () => {
          await replaceSessionEntry(
            { agentId: "main", sessionKey: key, storePath: database.path, env },
            { sessionId: "session-id", lifecycleRevision: "life-b", updatedAt: 2 },
          );
        },
        closeDatabase: () => closeOpenClawAgentDatabaseByPathAsync(database.path),
        advanceClock: () => {
          now += 2_000;
        },
        enableModel: () => {
          utilityModelRef = "openai/gpt-test";
        },
        watch: (enabled) => {
          if (enabled) {
            subscribers.subscribe("viewer", key)?.commit();
          } else {
            subscribers.unsubscribe("viewer", key);
          }
        },
        replaceStore: async () => {
          const storePath = path("replacement.sqlite");
          await replaceSessionEntry(
            { agentId: "main", sessionKey: key, storePath, env },
            {
              sessionId: "session-id",
              lifecycleRevision: "life-a",
              updatedAt: 1,
            },
          );
          cfg.session.store = storePath;
        },
      });
    } finally {
      await observer.disposeAsync();
      peer.close();
      vi.restoreAllMocks();
    }
  });
}

it("moves observer admission, publication, terminal and companion reads off the caller and observes foreign resets", async () => {
  await withObserver(async ({ observer, broadcast, resetLifecycle }) => {
    const start = event({ stream: "lifecycle", data: { phase: "start" } });
    const sql = observeMainThreadSql();
    try {
      observer.handleEvent(start);
      expect(sql.count()).toBeGreaterThan(0);
      sql.clear();
      await observer.handleEventAsync({ ...start, runId: "worker-run" });
      await observer.handleEventAsync(
        event({
          runId: "worker-run",
          stream: "item",
          data: { kind: "preamble", progressText: "Worker observation" },
        }),
      );
      const snapshot = await observer.getCompanionSnapshotAsync(key, "main");
      expect(snapshot.digest?.headline).toBe("Worker observation");
      sql.expectIdle();
      sql.restore();
      await resetLifecycle();
      const after = observeMainThreadSql();
      try {
        expect((await observer.getCompanionSnapshotAsync(key, "main")).digest).toBeUndefined();
        await observer.handleEventAsync(
          event({ runId: "worker-run", stream: "lifecycle", data: { phase: "end" } }),
        );
        await observer.disposeAsync();
        expect(broadcast).toHaveBeenCalledTimes(1);
        after.expectIdle();
      } finally {
        after.restore();
      }
    } finally {
      sql.restore();
    }
  });
});

it.for(["rewrite", "native rewrite", "close"] as const)(
  "refuses a companion snapshot when its read owner changes before consumption (%s)",
  async (change) => {
    await withObserver(
      async ({ observer, rewriteLifecycle, rewriteLifecycleWithoutPublication, closeDatabase }) => {
        await observer.handleEventAsync(
          event({ stream: "item", data: { kind: "preamble", progressText: "Previous lifecycle" } }),
        );
        let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
        interceptNextEntryRead(() => {
          if (change === "rewrite") {
            rewriteLifecycle();
          } else if (change === "native rewrite") {
            rewriteLifecycleWithoutPublication();
          } else {
            closing = closeDatabase();
          }
        });
        try {
          await expect(observer.getCompanionSnapshotAsync(key, "main")).rejects.toThrow(
            /changed|revoked|closed|current|admission/i,
          );
        } finally {
          await closing;
        }
      },
    );
  },
);

it("keeps queued preambles and terminal events behind awaited start admission", async () => {
  await withObserver(async ({ observer, broadcast, persisted }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const read = sessionReads.withGatewaySessionStoreTarget;
    vi.spyOn(sessionReads, "withGatewaySessionStoreTarget").mockImplementationOnce(
      async (params, consume) => {
        entered.resolve();
        await release.promise;
        return read(params, consume);
      },
    );
    const start = observer.handleEventAsync(
      event({ stream: "lifecycle", data: { phase: "start" } }),
    );
    const preamble = observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Queued note" } }),
    );
    const terminal = observer.handleEventAsync(
      event({ stream: "lifecycle", data: { phase: "end" } }),
    );
    try {
      await entered.promise;
      expect(broadcast).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all([start, preamble, terminal]);
      await observer.disposeAsync();
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ headline: "Queued note" });
      expect(persisted.mock.calls.at(-1)?.[0]).toMatchObject({ digest: { health: "done" } });
      await expect(
        observer.handleEventAsync(event({ stream: "lifecycle", data: { phase: "start" } })),
      ).rejects.toThrow("closed");
    } finally {
      release.resolve();
      await Promise.allSettled([start, preamble, terminal]);
    }
  });
});

it("fences an already returned row immediately when reset notification arrives", async () => {
  await withObserver(async ({ observer, broadcast, rewriteLifecycle }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    interceptNextEntryRead(async () => {
      entered.resolve();
      await release.promise;
    });
    const old = observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Retired work" } }),
    );
    const refused = expect(old).rejects.toThrow("Session entry changed during read");
    try {
      await entered.promise;
      rewriteLifecycle();
      notifyGatewaySessionReset(key, "main");
      release.resolve();
      await refused;
      await observer.handleEventAsync(
        event({
          runId: "successor",
          stream: "item",
          data: { kind: "preamble", progressText: "Current work" },
        }),
      );
      expect(broadcast.mock.calls.map((call) => call[1])).toEqual([
        expect.objectContaining({
          runId: "successor",
          headline: "Current work",
          lifecycleRevision: "life-b",
        }),
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([old]);
    }
  });
});

it("does not disclose a predecessor digest when the configured store changes with matching session identities", async () => {
  await withObserver(async ({ observer, replaceStore, advanceClock }) => {
    await observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Previous store" } }),
    );
    expect((await observer.getCompanionSnapshotAsync(key, "main")).digest?.headline).toBe(
      "Previous store",
    );
    await replaceStore();
    advanceClock();
    expect(() =>
      observer.handleEvent(
        event({
          stream: "item",
          data: {
            kind: "preamble",
            progressText: "Unowned source",
          },
        }),
      ),
    ).toThrow("Session access facts are unavailable");
    expect(await observer.getCompanionSnapshotAsync(key, "main")).toEqual({
      agentId: "main",
      notes: [],
    });
  });
});

it("does not write a dormant predecessor digest into a replacement store", async () => {
  await withObserver(async ({ observer, watch, replaceStore, persisted }) => {
    await observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Predecessor work" } }),
    );
    expect(persisted).toHaveBeenCalledOnce();
    watch(false);
    await replaceStore();
    persisted.mockClear();
    await observer.handleEventAsync(event({ stream: "lifecycle", data: { phase: "end" } }));
    await observer.disposeAsync();
    expect(persisted).not.toHaveBeenCalled();
  });
});

it.for(["sync", "async"] as const)(
  "resumes a dormant observer after %s admission when terminal context omits the agent",
  async (mode, { signal }) => {
    await withObserver(async ({ observer, watch, enableModel, finalized }) => {
      const initial = event({
        stream: "item",
        data: { kind: "preamble", progressText: "Retained work" },
      });
      if (mode === "sync") {
        observer.handleEvent(initial);
      } else {
        await observer.handleEventAsync(initial);
      }
      watch(false);
      enableModel();
      watch(true);
      const terminal = event({
        stream: "lifecycle",
        data: { phase: "end", startedAt: 0, endedAt: 31_000 },
      });
      delete terminal.agentId;
      await observer.handleEventAsync(terminal);
      await withinTest(finalized, signal);
    });
  },
);

it("clears retained observer state before synchronous disposal returns", async () => {
  await withObserver(async ({ observer }) => {
    observer.handleEvent(
      event({ stream: "item", data: { kind: "preamble", progressText: "Retained work" } }),
    );
    expect(observer.getCompanionSnapshot(key, "main").digest?.headline).toBe("Retained work");
    observer.dispose();
    expect(observer.getCompanionSnapshot(key, "main")).toEqual({ agentId: "main", notes: [] });
  });
});

it("joins the worker-backed persistence of a synchronously admitted digest", async () => {
  await withObserver(async ({ observer, peer }) => {
    observer.handleEvent(
      event({ stream: "item", data: { kind: "preamble", progressText: "Legacy admission" } }),
    );
    await observer.disposeAsync();
    expect(
      peer
        .prepare(
          "SELECT json_extract(entry_json, '$.observerDigest.headline') AS headline FROM session_nodes WHERE session_key = ?",
        )
        .get(key),
    ).toEqual({ headline: "Legacy admission" });
  }, true);
});

it("fences a context-reduced dormant read before it can retire a reset successor", async ({
  signal,
}) => {
  await withObserver(async ({ observer, watch, enableModel, rewriteLifecycle }) => {
    await observer.handleEventAsync(
      event({ stream: "item", data: { kind: "preamble", progressText: "Retained work" } }),
    );
    watch(false);
    enableModel();
    watch(true);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    interceptNextEntryRead(async () => {
      entered.resolve();
      await release.promise;
    });
    const terminal = event({
      stream: "lifecycle",
      data: { phase: "end", startedAt: 0, endedAt: 31_000 },
    });
    delete terminal.agentId;
    const pending = observer.handleEventAsync(terminal);
    const refused = expect(pending).rejects.toThrow("Session entry changed during read");
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Dormant read did not enter its retained worker",
        ),
        signal,
      );
      rewriteLifecycle();
      observer.handleEvent(
        event({
          runId: "successor",
          stream: "item",
          data: { kind: "preamble", progressText: "Successor work" },
        }),
      );
      notifyGatewaySessionReset(key, "main");
      release.resolve();
      await refused;
      expect((await observer.getCompanionSnapshotAsync(key, "main")).digest).toMatchObject({
        runId: "successor",
        headline: "Successor work",
        lifecycleRevision: "life-b",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([pending, refused]);
    }
  });
});
