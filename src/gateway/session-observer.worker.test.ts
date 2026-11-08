import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as entryFacts from "../config/sessions/session-entry-read-facts.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import * as observerWork from "./session-observer-work.js";
import { createSessionObserver } from "./session-observer.js";
import {
  createHarness,
  event,
  modelMessage,
  resetSessionObserverEventSequence,
} from "./session-observer.test-utils.js";
import { notifyGatewaySessionReset } from "./session-reset-notifications.js";
import * as sessionReads from "./session-utils-store-lookup.js";

const key = "agent:main:session-1";
const initialEntry = { sessionId: "session-id", lifecycleRevision: "life-a", updatedAt: 1 };
const successorEntry = { ...initialEntry, lifecycleRevision: "life-b", updatedAt: 2 };
const lifecycleUpdate =
  "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.lifecycleRevision', 'life-b') WHERE session_key = ?";
const preambleEvent = (progressText: string) =>
  event({ stream: "item", data: { kind: "preamble", progressText } });
const observerConfig = (store: string | undefined, utilityModel = ""): OpenClawConfig => ({
  session: { store },
  gateway: { controlUi: { sessionObserver: true } },
  agents: { defaults: { utilityModel } },
});

function traceSql() {
  const trace = observeMainThreadSql();
  return { ...trace, [Symbol.dispose]: () => trace.restore() };
}

function send(
  observer: ReturnType<typeof createSessionObserver>,
  stream: string,
  data: Record<string, unknown>,
  runId?: string,
) {
  return observer.handleEventAsync(event({ stream, data, runId }));
}

function sendPreamble(
  observer: ReturnType<typeof createSessionObserver>,
  progressText: string,
  runId?: string,
) {
  return send(observer, "item", { kind: "preamble", progressText }, runId);
}

function interceptNextEntryRead(storePath: string, afterRead: () => void | Promise<void>) {
  // Exercise the worker's in-flight read, even when the preceding observation warmed the key.
  sessionChanges.invalidate({
    agentId: "main",
    storePath,
    sessionKey: key,
    factsInvalidated: true,
  });
  const createReaders = historyReaders.createSessionHistoryWorkerReaders;
  const intercepted = vi.fn(afterRead);
  vi.spyOn(historyReaders, "createSessionHistoryWorkerReaders").mockImplementation((runRequest) => {
    const readers = createReaders(runRequest);
    return {
      ...readers,
      readExactEntries: async (...args) => {
        const result = await readers.readExactEntries(...args);
        if (intercepted.mock.calls.length === 0) {
          await intercepted();
        }
        return result;
      },
    };
  });
  return intercepted;
}

function observerFixture(
  { env, path }: OpenClawTestState,
  persistDigests = false,
  useDefaultStore = false,
) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  writeSessionEntry(database, key, initialEntry);
  const peer = new DatabaseSync(database.path);
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe("viewer", key)?.commit();
  const broadcast = vi.fn();
  const persisted = vi.fn<NonNullable<SessionObserverDeps["persistDigest"]>>(async () => true);
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const cfg = {
    session: { store: useDefaultStore ? undefined : database.path },
    agents: { defaults: { utilityModel: "" } },
  };
  const observer = createSessionObserver({
    getConfig: () => cfg,
    subscribers,
    broadcastToConnIds: broadcast,
    ...(persistDigests ? {} : { persistDigest: persisted }),
  });
  observer.setConnectionVisibility("viewer", true);
  return {
    observer,
    broadcast,
    persisted,
    peer,
    storePath: database.path,
    rewriteLifecycle: () => writeSessionEntry(database, key, successorEntry),
    rewriteLifecycleWithoutPublication: () => {
      database.db.prepare(lifecycleUpdate).run(key);
    },
    resetLifecycle: () =>
      replaceSessionEntry(
        { agentId: "main", sessionKey: key, storePath: database.path, env },
        successorEntry,
      ),
    closeDatabase: () => closeOpenClawAgentDatabaseByPathAsync(database.path),
    advanceClock: () => {
      now += 2_000;
    },
    watch: (enabled: boolean) => {
      if (enabled) {
        subscribers.subscribe("viewer", key)?.commit();
      } else {
        subscribers.unsubscribe("viewer", key);
      }
    },
    replaceStore: async () => {
      const storePath = path("replacement.sqlite");
      await replaceSessionEntry({ agentId: "main", sessionKey: key, storePath, env }, initialEntry);
      cfg.session.store = storePath;
    },
  };
}

async function withObserver(
  run: (fixture: ReturnType<typeof observerFixture>) => Promise<void>,
  persistDigests = false,
  useDefaultStore = false,
) {
  await withOpenClawTestState({ label: "observer-worker" }, async (state) => {
    const fixture = observerFixture(state, persistDigests, useDefaultStore);
    try {
      await run(fixture);
    } finally {
      await fixture.observer.disposeAsync();
      fixture.peer.close();
      vi.restoreAllMocks();
    }
  });
}

it("does not discover physical stores for unwatched assistant deltas", async () => {
  await withObserver(async ({ observer, watch }) => {
    watch(false);
    await send(observer, "lifecycle", { phase: "start" });
    const realpath = vi.spyOn(fs.realpathSync, "native");
    for (const delta of ["Checking ", "the implementation."]) {
      await send(observer, "assistant", { delta });
    }
    expect(realpath).not.toHaveBeenCalled();
  });
});

it("moves observer admission, publication, terminal and companion reads off the caller and observes foreign resets", async () => {
  await withObserver(
    async ({ observer, broadcast, peer, resetLifecycle, advanceClock }) => {
      // Keep entry reads cold while target discovery retains its admitted inventory.
      vi.spyOn(entryFacts, "readRetainedSessionEntryFacts").mockReturnValue(undefined);
      const start = event({ stream: "lifecycle", data: { phase: "start" } });
      {
        using sql = traceSql();
        observer.handleEvent(start);
        sql.expectIdle();
        sql.clear();
        await observer.handleEventAsync({ ...start, runId: "worker-run" });
        await sendPreamble(observer, "Worker observation", "worker-run");
        for (const delta of ["Checking ", "the implementation."]) {
          await send(observer, "assistant", { delta }, "worker-run");
        }
        const snapshot = await observer.getCompanionSnapshotAsync(key, "main");
        expect(snapshot.digest?.headline).toBe("Worker observation");
        expect(snapshot.notes).toContainEqual({
          sequence: 1,
          text: "Assistant: Checking the implementation.",
        });
        sql.expectIdle();
        sql.restore();
        peer.prepare(lifecycleUpdate).run(key);
        advanceClock();
        {
          using fresh = traceSql();
          await sendPreamble(observer, "Retired observation", "worker-run");
          expect(broadcast).toHaveBeenCalledTimes(1);
          fresh.expectIdle();
        }
        await resetLifecycle();
        {
          using after = traceSql();
          expect((await observer.getCompanionSnapshotAsync(key, "main")).digest).toBeUndefined();
          await send(observer, "lifecycle", { phase: "end" }, "worker-run");
          await observer.disposeAsync();
          expect(broadcast).toHaveBeenCalledTimes(1);
          after.expectIdle();
        }
      }
    },
    false,
    true,
  );
});

it.for(["rewrite", "native rewrite", "close"] as const)(
  "refuses a companion snapshot when its read owner changes before consumption (%s)",
  async (change) => {
    await withObserver(
      async ({
        observer,
        storePath,
        rewriteLifecycle,
        rewriteLifecycleWithoutPublication,
        closeDatabase,
      }) => {
        await sendPreamble(observer, "Previous lifecycle");
        let closing: ReturnType<typeof closeOpenClawAgentDatabaseByPathAsync> | undefined;
        const runExternalClose = AsyncLocalStorage.snapshot();
        const intercepted = interceptNextEntryRead(storePath, () => {
          if (change === "rewrite") {
            rewriteLifecycle();
          } else if (change === "native rewrite") {
            rewriteLifecycleWithoutPublication();
          } else {
            closing = runExternalClose(closeDatabase);
          }
        });
        try {
          await expect(observer.getCompanionSnapshotAsync(key, "main")).rejects.toThrow(
            /changed|revoked|closed|current|admission/i,
          );
          expect(intercepted).toHaveBeenCalledOnce();
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
    const start = send(observer, "lifecycle", { phase: "start" });
    const preamble = sendPreamble(observer, "Queued note");
    const terminal = send(observer, "lifecycle", { phase: "end" });
    try {
      await entered.promise;
      expect(broadcast).not.toHaveBeenCalled();
      release.resolve();
      await Promise.all([start, preamble, terminal]);
      await observer.disposeAsync();
      expect(broadcast.mock.calls[0]?.[1]).toMatchObject({ headline: "Queued note" });
      expect(persisted.mock.calls.at(-1)?.[0]).toMatchObject({ digest: { health: "done" } });
      await expect(send(observer, "lifecycle", { phase: "start" })).rejects.toThrow("closed");
    } finally {
      release.resolve();
      await Promise.allSettled([start, preamble, terminal]);
    }
  });
});

it("fences an already returned row immediately when reset notification arrives", async () => {
  await withObserver(async ({ observer, broadcast, storePath, rewriteLifecycle }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    interceptNextEntryRead(storePath, async () => {
      entered.resolve();
      await release.promise;
    });
    const old = sendPreamble(observer, "Retired work");
    const refused = expect(old).rejects.toThrow("Session entry changed during read");
    try {
      await entered.promise;
      rewriteLifecycle();
      notifyGatewaySessionReset(key, "main");
      release.resolve();
      await refused;
      await sendPreamble(observer, "Current work", "successor");
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
    await sendPreamble(observer, "Previous store");
    expect((await observer.getCompanionSnapshotAsync(key, "main")).digest?.headline).toBe(
      "Previous store",
    );
    await replaceStore();
    advanceClock();
    observer.handleEvent(preambleEvent("Unowned source"));
    expect(await observer.getCompanionSnapshotAsync(key, "main")).toEqual({
      agentId: "main",
      notes: [],
    });
    await sendPreamble(observer, "Replacement store", "replacement-run");
    expect((await observer.getCompanionSnapshotAsync(key, "main")).digest).toMatchObject({
      runId: "replacement-run",
      headline: "Replacement store",
    });
  });
});

it("does not write a dormant predecessor digest into a replacement store", async () => {
  await withObserver(async ({ observer, watch, replaceStore, persisted }) => {
    await sendPreamble(observer, "Predecessor work");
    expect(persisted).toHaveBeenCalledOnce();
    watch(false);
    await replaceStore();
    persisted.mockClear();
    await send(observer, "lifecycle", { phase: "end" });
    await observer.disposeAsync();
    expect(persisted).not.toHaveBeenCalled();
  });
});

it("joins the worker-backed persistence of a legacy event adapter", async () => {
  await withObserver(async ({ observer, peer }) => {
    expect(observer.handleEvent(preambleEvent("Legacy admission"))).toBeUndefined();
    const disposal = observer.disposeAsync();
    const afterClose = preambleEvent("Rejected after close");
    observer.handleEvent(afterClose);
    await expect(observer.handleEventAsync(afterClose)).rejects.toThrow(
      "Session observer is closed",
    );
    await disposal;
    expect(
      peer
        .prepare(
          "SELECT json_extract(entry_json, '$.observerDigest.headline') AS headline FROM session_nodes WHERE session_key = ?",
        )
        .get(key),
    ).toEqual({ headline: "Legacy admission" });
  }, true);
});

it("lets the publisher finish its nested write before persisting the background digest", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", path: state.path("sessions.sqlite"), env: state.env };
    const entered = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    let digestEntered = false;
    const persistDigest = vi.fn(() =>
      runOpenClawAgentWorkerWrite(options, async () => {
        digestEntered = true;
        entered.resolve();
        await release.promise;
        order.push("persisted");
        return true;
      }),
    );
    const harness = createHarness({ config: observerConfig(options.path), persistDigest });
    let successor: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    try {
      await runOpenClawAgentWriteAdmission(options, async () => {
        await harness.observer.handleEventAsync(preambleEvent("Reviewing"));
        expect(persistDigest).toHaveBeenCalledOnce();
        expect(digestEntered).toBe(false);
        await runOpenClawAgentWorkerWrite(options, async () => {
          order.push("publisher");
        });
      });
      await withinTest(entered.promise, signal);
      successor = runOpenClawAgentWriteAdmission(options, () =>
        runOpenClawAgentWorkerWrite(options, async () => {
          order.push("successor");
        }),
      );
      disposal = harness.observer.disposeAsync().then(() => {
        order.push("disposed");
      });
      release.resolve();
      await withinTest(Promise.all([successor, disposal]), signal);
      expect(order.slice(0, 2)).toEqual(["publisher", "persisted"]);
      expect(order).toHaveLength(4);
    } finally {
      release.resolve();
      await Promise.allSettled([successor, disposal]);
      await harness.observer.disposeAsync();
      resetSessionObserverEventSequence();
    }
  });
});

it.for(["model", "failed model", "synthesized terminal"] as const)(
  "rechecks physical source authority before consuming a %s digest",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config = observerConfig(
        state.path("original.sqlite"),
        kind === "synthesized terminal" ? "" : "openai/gpt-test",
      );
      const replacementStore = state.path("replacement.sqlite");
      let changeSourceOnRead = false;
      let sourceChanges = 0;
      const pending: Promise<unknown>[] = [];
      const settle = async () => {
        while (pending.length) {
          await withinTest(Promise.allSettled(pending.splice(0)), signal);
        }
      };
      const createWork = observerWork.createSessionObserverWork;
      vi.spyOn(observerWork, "createSessionObserverWork").mockImplementation((params) => {
        const work = createWork(params);
        const withCurrent = work.withCurrent.bind(work);
        vi.spyOn(work, "withCurrent").mockImplementation((...args) => {
          if (changeSourceOnRead) {
            changeSourceOnRead = false;
            config.session = { store: replacementStore };
            sourceChanges += 1;
          }
          return withCurrent(...args);
        });
        const background = work.background.bind(work);
        vi.spyOn(work, "background").mockImplementation((run) => {
          background(() => {
            const result = run();
            pending.push(result);
            return result;
          });
        });
        return work;
      });
      let harness: ReturnType<typeof createHarness> | undefined;
      try {
        harness = createHarness({
          config,
          readSession: vi.fn(() => ({ ...initialEntry, lifecycleRevision: "owned" })),
          completeModel: vi.fn(async () => {
            if (kind === "failed model") {
              throw new Error("model request failed");
            }
            return modelMessage({ headline: "Finished reviewing", health: "done" });
          }),
        });
        const observer = harness.observer;
        const deliver = (stream: string, data: Record<string, unknown>) =>
          withinTest(send(observer, stream, data), signal);
        if (kind !== "synthesized terminal") {
          await deliver("lifecycle", { phase: "start", startedAt: 0 });
          await deliver("tool", { phase: "start", name: "read", args: { path: "example.ts" } });
        } else {
          await deliver("item", { kind: "preamble", progressText: "Reviewing", startedAt: 0 });
          await settle();
          expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
          expect(harness.persistDigest).toHaveBeenCalledOnce();
          harness.broadcastToConnIds.mockClear();
          harness.persistDigest.mockClear();
        }
        changeSourceOnRead = true;
        await deliver("lifecycle", { phase: "end", startedAt: 0, endedAt: 31_000 });
        await settle();

        expect(sourceChanges).toBe(1);
        expect(config.session?.store).toBe(replacementStore);
        expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
        if (kind !== "synthesized terminal") {
          expect(harness.completeModel).toHaveBeenCalledOnce();
          expect(harness.persistDigest).not.toHaveBeenCalled();
        } else {
          expect(harness.completeModel).not.toHaveBeenCalled();
          expect(harness.persistDigest).toHaveBeenCalledOnce();
          expect(harness.persistDigest.mock.calls[0]?.[0].digest).toMatchObject({ health: "done" });
        }
      } finally {
        try {
          await harness?.observer.disposeAsync();
        } finally {
          vi.restoreAllMocks();
          resetSessionObserverEventSequence();
        }
      }
    });
  },
);
