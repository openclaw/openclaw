import { performance } from "node:perf_hooks";
import { expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionLifecyclePublisher } from "./server-chat-lifecycle-publication.js";
import { createSessionEventSubscriberRegistry } from "./server-chat-state.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import {
  drainSessionEventPublications,
  sessionEventPublicationRows,
  withPreparedSessionEventRow,
} from "./session-event-prepared-row.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { readPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

it.each([0, 7])(
  "lets I/O progress through a ready burst (publication cost %i ms)",
  async (cost) => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 12 }, (_, index) => `agent:main:burst-${index}`);
    const yieldedKey = "agent:main:burst-9";
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: Object.fromEntries(keys.map((key) => [key, { sessionId: key, updatedAt: 1 }])),
    });
    const held = createDeferredCore();
    let preparations = 0;
    projection.withPreparedExactRows = async (queries, consume) => {
      preparations++;
      if (queries(cfg)[0]?.key === keys[0]) {
        await held.promise;
      }
      return readPreparedSessionRows(projection, () => true, queries, consume);
    };
    const published: string[] = [];
    const labels = new Map<string, string | undefined>();
    let atIo = -1;
    setImmediate(() => {
      atIo = published.length;
      projection.setEntry(yieldedKey, {
        sessionId: yieldedKey,
        updatedAt: 2,
        label: "after yield",
      });
    });
    const work = keys.map((key) =>
      withPreparedSessionEventRow(projection, key, "main", () => {
        published.push(key);
        labels.set(key, projection.snapshot({ key, agentId: "main" }).row?.label);
        now += cost;
      }),
    );
    const settled = Promise.all(work);
    try {
      await vi.runAllTimersAsync();
      expect(atIo).toBeGreaterThan(0);
      expect(atIo).toBeLessThan(keys.length - 1);
      expect(published).toEqual(keys.slice(1));
      expect(labels.get(yieldedKey)).toBe("after yield");
      held.resolve();
      await vi.runAllTimersAsync();
      await settled;
      await drainSessionEventPublications(projection);
      expect(published).toEqual([...keys.slice(1), keys[0]]);
      expect(preparations).toBeLessThanOrEqual(keys.length * 2);
    } finally {
      held.resolve();
      await vi.runAllTimersAsync();
      await settled;
      projection.dispose();
      clock.mockRestore();
      vi.useRealTimers();
    }
  },
);

it.each(["replacement", "reset"])(
  "drops an old lifecycle receipt after a yielded %s",
  async (kind) => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const changedKey = "agent:main:changed";
    const keys = ["agent:main:first", changedKey];
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: Object.fromEntries(keys.map((key) => [key, { sessionId: key, updatedAt: 1 }])),
    });
    const broadcastToConnIds = vi.fn(() => {
      now += 7;
    });
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["viewer"]) },
      chatAbortControllers: new Map(),
      getSessionRowProjection: () => projection,
    });
    setImmediate(() => {
      projection.setEntry(changedKey, {
        sessionId: kind === "replacement" ? "replacement" : changedKey,
        lifecycleRevision: "new-lifecycle",
        updatedAt: 2,
      });
    });
    const publications = keys.map((sessionKey) => handler({ sessionKey, reason: "rename" }));
    onTestFinished(async () => {
      await vi.runAllTimersAsync();
      await Promise.allSettled(publications);
      await drainSessionEventPublications(projection);
      projection.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    await vi.runAllTimersAsync();
    await Promise.all(publications);
    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: keys[0], reason: "rename" }),
      new Set(["viewer"]),
      { dropIfSlow: true, prepareSessionProjection: expect.any(Function) },
    );
  },
);

it("publishes lifecycle rows after their producer drains and before publication shutdown", async () => {
  const cfg = { agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(cfg);
  const sessionKey = "agent:main:lifecycle-publication";
  const projection = createSessionRowProjectionFixture({
    cfg,
    store: { [sessionKey]: { sessionId: "lifecycle-session", updatedAt: 1, label: "Collector A" } },
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  projection.withPreparedExactRows = async (queries, consume) => {
    entered.resolve();
    await release.promise;
    return readPreparedSessionRows(projection, () => true, queries, consume);
  };
  const order: string[] = [];
  const broadcastToConnIds = vi.fn(() => order.push("publication"));
  const handler = createLifecycleEventBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["viewer"]) },
    chatAbortControllers: new Map(),
    getSessionRowProjection: () => projection,
  });
  const producer = new AsyncWorkScope();
  const publication = producer.run(() => handler({ sessionKey, reason: "rename" }));
  onTestFinished(async () => {
    release.resolve();
    await Promise.allSettled([publication]);
    await producer.drain();
    await drainSessionEventPublications(projection);
    projection.dispose();
  });
  await entered.promise;
  const drain = drainSessionEventPublications(projection).then(() => order.push("drained"));
  await producer.drain();
  release.resolve();
  await Promise.all([publication, drain]);
  expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey,
      reason: "rename",
      session: expect.objectContaining({ sessionId: "lifecycle-session", label: "Collector A" }),
    }),
    new Set(["viewer"]),
    { dropIfSlow: true, prepareSessionProjection: expect.any(Function) },
  );
  expect(order).toEqual(["publication", "drained"]);
});

it("rejects asynchronous prepared consumers", async () => {
  const projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
  projection.withPreparedExactRows = async (queries, consume) =>
    readPreparedSessionRows(projection, () => true, queries, consume);
  onTestFinished(async () => {
    await drainSessionEventPublications(projection);
    projection.dispose();
    vi.restoreAllMocks();
  });
  const rows = sessionEventPublicationRows(projection);
  await expect(
    rows.withPreparedExactRows(
      () => [],
      async () => undefined,
    ),
  ).rejects.toThrow("Session row read consumers must remain synchronous");
});

it("keeps prepared exact rows and ancestors inside the synchronous publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const parentKey = "agent:main:event-parent";
    const childKey = "agent:main:event-child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parentKey },
      { sessionId: "parent", updatedAt: 1, archivedAt: 1 },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: childKey },
      { sessionId: "child", updatedAt: 1, archivedAt: 1, spawnedBy: parentKey },
    );
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(0);
      let retained: SessionRowReadView | undefined;
      const publish = vi.fn((read?: SessionRowReadView) => {
        retained = read;
        const row = read?.describe({ key: childKey, agentId: "main" });
        expect(row?.entry.sessionId).toBe("child");
        expect(
          row && projection.ancestorRows(row, read)?.map((ancestor) => ancestor.entry.sessionId),
        ).toEqual(["parent"]);
      });
      await withPreparedSessionEventRow(projection, childKey, "main", publish);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(() => retained?.describe({ key: childKey, agentId: "main" })).toThrow(
        "no longer active",
      );
    } finally {
      projection.dispose();
      release();
    }
  });
});

it("publishes an unscoped lifecycle event without materializing unrelated dirty rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } },
    };
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:unrelated" };
    replaceSessionEntrySync(target, { sessionId: "unrelated", updatedAt: 1 });
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      replaceSessionEntrySync(target, {
        sessionId: "unrelated",
        updatedAt: 2,
        label: "Pending unrelated update",
      });
      const dirtyRows = projection.dirtyRowCount;
      const materialized = projection.materializedCount;
      expect(dirtyRows).toBeGreaterThan(0);
      const delivered = createDeferredCore();
      const broadcastToConnIds = vi.fn(() => delivered.resolve());
      const subscribers = createSessionEventSubscriberRegistry();
      subscribers.subscribe("viewer");
      const publisher = createSessionLifecyclePublisher({
        broadcastToConnIds,
        sessionEventSubscribers: subscribers,
        getSessionRowProjection: () => projection,
        // An unresolved routing owner has no readable lifecycle snapshot.
        loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
        persistGatewaySessionLifecycleEventForEvent: async () => undefined,
      });
      const event = {
        runId: "unscoped-run",
        seq: 1,
        ts: 100,
        stream: "lifecycle",
        data: { phase: "start" },
      };
      publisher.publish({
        event,
        phase: "start",
        sessionKey: "unscoped",
        agentId: undefined,
        clientRunId: event.runId,
        runContext: undefined,
      });
      await delivered.promise;
      expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
        "sessions.changed",
        { sessionKey: "unscoped", phase: "start", runId: event.runId, ts: event.ts },
        new Set(["viewer"]),
        { dropIfSlow: true },
      );
      expect(projection.dirtyRowCount).toBe(dirtyRows);
      expect(projection.materializedCount).toBe(materialized);
    } finally {
      projection.dispose();
      release();
    }
  });
});
