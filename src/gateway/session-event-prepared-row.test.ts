import { performance } from "node:perf_hooks";
import { expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import {
  drainSessionEventPublications,
  sessionEventPublicationRows,
  withPreparedSessionEventRow,
} from "./session-event-prepared-row.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withPreparedSessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

it.each([0, 7])(
  "lets I/O progress through a ready burst (publication cost %i ms)",
  async (cost) => {
    vi.useFakeTimers({ toFake: ["setImmediate", "clearImmediate"] });
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 12 }, (_, index) => `agent:main:burst-${index}`);
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: Object.fromEntries(keys.map((key) => [key, { sessionId: key, updatedAt: 1 }])),
    });
    const held = createDeferredCore();
    projection.withPreparedExactRows = async (queries, consume) => {
      if (queries(cfg)[0]?.key === keys[0]) {
        await held.promise;
      }
      return withPreparedSessionRows(projection, () => true, queries, consume);
    };
    const published: string[] = [];
    const labels = new Map<string, string | undefined>();
    let atIo = -1;
    setImmediate(() => {
      atIo = published.length;
      projection.setEntry(keys[9], { sessionId: keys[9], updatedAt: 2, label: "after yield" });
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
      expect(labels.get(keys[9])).toBe("after yield");
      held.resolve();
      await vi.runAllTimersAsync();
      await settled;
      await drainSessionEventPublications(projection);
      expect(published).toEqual([...keys.slice(1), keys[0]]);
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
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const keys = ["agent:main:first", "agent:main:changed"];
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
      projection.setEntry(keys[1], {
        sessionId: kind === "replacement" ? "replacement" : keys[1],
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
      { dropIfSlow: true },
    );
  },
);

it("retains canonical deferral and rejects asynchronous prepared consumers", async () => {
  const projection = createSessionRowProjectionFixture({ cfg: {}, store: {} });
  projection.withPreparedExactRows = (queries, consume) =>
    withPreparedSessionRows(projection, () => true, queries, consume);
  const database = { agentId: "main", path: "/synthetic/pending.sqlite" };
  vi.spyOn(projection, "withPreparedExactRows").mockResolvedValueOnce({
    kind: "pending",
    database,
  });
  onTestFinished(async () => {
    await drainSessionEventPublications(projection);
    projection.dispose();
    vi.restoreAllMocks();
  });
  const rows = sessionEventPublicationRows(projection);
  const publish = vi.fn();
  await expect(rows.withPreparedExactRows(() => [], publish)).resolves.toEqual({
    kind: "pending",
    database,
  });
  expect(publish).not.toHaveBeenCalled();
  await expect(
    rows.withPreparedExactRows(
      () => [],
      async () => undefined,
    ),
  ).rejects.toThrow("Session row read consumers must remain synchronous");
});

it("publishes without forwarding the prepared view while exact rows and ancestors are ready", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
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
      const publish = vi.fn((..._args: unknown[]) => {
        const row = projection.describe({ key: childKey, agentId: "main" });
        expect(row?.entry.sessionId).toBe("child");
        expect(
          row && projection.ancestorRows(row)?.map((ancestor) => ancestor.entry.sessionId),
        ).toEqual(["parent"]);
      });
      await withPreparedSessionEventRow(projection, childKey, "main", publish);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.length).toBe(0);
    } finally {
      projection.dispose();
      release();
    }
  });
});
