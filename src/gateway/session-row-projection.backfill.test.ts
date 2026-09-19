import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  emitSessionIdentityMutation,
  emitSessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { create, type Row } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => vi.restoreAllMocks());

async function withStreamingProjection(
  run: (fixture: {
    projection: Awaited<ReturnType<typeof createSessionRowProjection>>;
    target: { agentId: string; sessionKey: string; sessionId: string };
    query: { agentId: string; key: string };
    append: (content: string) => Promise<void>;
    release: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:stream", sessionId: "stream" };
    for (const [name, parent] of [["parent"], ["stream", "parent"], ["child", "stream"]] as const) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:${name}` },
        {
          sessionId: name,
          updatedAt: 1,
          displayName: name,
          ...(parent ? { parentSessionKey: `agent:main:${parent}` } : {}),
        },
      );
    }
    // Hold optional backfill at its real foreground gate to count invalidation work separately.
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await run({
        projection,
        target,
        query: { agentId: "main", key: target.sessionKey },
        async append(content) {
          await persistSessionTranscriptTurn(target, {
            messages: [{ message: { role: "assistant", content } }],
            touchSessionEntry: false,
          });
          await projection.ensureMaterialized();
        },
        release,
      });
    } finally {
      projection.dispose();
      release();
      vi.useRealTimers();
    }
  });
}

it("coalesces streaming transcript refreshes without refreshing parents or children", async () => {
  await withStreamingProjection(async ({ projection, query, append, release }) => {
    const before = projection.materializedCount;
    await append("Update 1");
    expect(projection.materializedCount - before).toBe(1);
    for (let index = 2; index <= 10; index++) {
      await append(`Update ${index}`);
    }
    expect(projection.materializedCount - before).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    await projection.ensureMaterialized();
    expect(projection.materializedCount - before).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await projection.ensureMaterialized();
    expect(projection.materializedCount - before).toBe(2);
    await append("Update 11");
    expect(projection.materializedCount - before).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await projection.ensureMaterialized();
    expect(projection.materializedCount - before).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(projection.materializedCount - before).toBe(3);
    release();
    vi.useRealTimers();
    await vi.waitFor(() =>
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
        lastMessagePreview: "Update 11",
      }),
    );
  });
});

it("refreshes committed metadata and lifecycle marks during a transcript window", async () => {
  await withStreamingProjection(async ({ projection, target, query, append }) => {
    await append("Leading update");
    const before = projection.materializedCount;
    await append("Pending update");
    expect(projection.materializedCount).toBe(before);
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 2,
      displayName: "Renamed immediately",
      parentSessionKey: "agent:main:parent",
    });
    expect(projection.snapshot(query).row?.displayName).toBe("Renamed immediately");
    await projection.ensureMaterialized();
    const afterMetadata = projection.materializedCount;
    emitSessionLifecycleEvent({ ...target, reason: "updated" });
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBeGreaterThan(afterMetadata);
  });
});

it("cancels a pending trailing transcript refresh on disposal", async () => {
  await withStreamingProjection(async ({ projection, append }) => {
    await append("Leading update");
    const before = projection.materializedCount;
    await append("Pending update");
    expect(projection.materializedCount).toBe(before);
    expect(vi.getTimerCount()).toBe(1);
    projection.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(before);
    expect(projection.selectEntries()).toEqual([]);
  });
});

it("does not carry a pending transcript refresh into a replacement session", async () => {
  await withStreamingProjection(async ({ projection, target, query, append }) => {
    await append("Leading update");
    await append("Pending update");
    expect(vi.getTimerCount()).toBe(1);
    replaceSessionEntrySync(target, {
      sessionId: "replacement",
      updatedAt: 2,
      displayName: "Replacement",
      parentSessionKey: "agent:main:parent",
    });
    emitSessionIdentityMutation({
      kind: "reset",
      agentId: target.agentId,
      previous: { sessionId: target.sessionId, sessionKeys: [target.sessionKey] },
      current: { sessionId: "replacement", sessionKeys: [target.sessionKey] },
    });
    await projection.ensureMaterialized();
    expect(projection.snapshot(query).row?.sessionId).toBe("replacement");
    expect(vi.getTimerCount()).toBe(0);
    const before = projection.materializedCount;
    await vi.advanceTimersByTimeAsync(1_000);
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBe(before);
    await persistSessionTranscriptTurn(
      { ...target, sessionId: "replacement" },
      { messages: [{ message: { role: "assistant", content: "New session" } }] },
    );
    await projection.ensureMaterialized();
    expect(projection.materializedCount - before).toBe(1);
  });
});

it("eventually fills legacy titles and previews without waiting during startup or changing activity", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:legacy", sessionId: "legacy" };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(target, {
      messages: [
        { message: { role: "user", content: "Investigate the slow session query" } },
        { message: { role: "assistant", content: "The query is now bounded." } },
      ],
      touchSessionEntry: false,
    });
    const before = loadSessionEntry(target);
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(loadSessionEntry(target)?.displayName).toBeUndefined();
      await vi.waitFor(() => {
        expect(
          projection.snapshot(
            { agentId: "main", key: target.sessionKey },
            {
              includeDerivedTitles: true,
              includeLastMessage: true,
            },
          ).row,
        ).toMatchObject({
          lastMessagePreview: "The query is now bounded.",
        });
      });
      expect(loadSessionEntry(target)).toEqual(before);
      expect(
        projection.snapshot(
          { agentId: "main", key: target.sessionKey },
          { includeDerivedTitles: true },
        ).row?.derivedTitle,
      ).toBeUndefined();
    } finally {
      projection.dispose();
    }
    await nextTurn();
    await noteSessionTranscriptHealth({
      cfg,
      shouldRepair: false,
      postSessionPluginMigrationPlanBound: true,
    });
    expect(loadSessionEntry(target)).toEqual(before);
    const expected = { ...before, displayName: "Investigate the slow session query" };
    for (let pass = 0; pass < 2; pass++) {
      await noteSessionTranscriptHealth({
        cfg,
        shouldRepair: true,
        postSessionPluginMigrationPlanBound: true,
      });
      expect(loadSessionEntry(target)).toEqual(expected);
    }
    const repairedProjection = await createSessionRowProjection({ cfg });
    try {
      await vi.waitFor(() => {
        expect(
          repairedProjection.snapshot(
            { agentId: "main", key: target.sessionKey },
            { includeDerivedTitles: true, includeLastMessage: true },
          ).row,
        ).toMatchObject({
          derivedTitle: "Investigate the slow session query",
          lastMessagePreview: "The query is now bounded.",
        });
      });
      replaceSessionEntrySync(target, { sessionId: "replacement", updatedAt: 2 });
      emitSessionIdentityMutation({
        kind: "reset",
        agentId: "main",
        previous: { sessionId: target.sessionId, sessionKeys: [target.sessionKey] },
        current: { sessionId: "replacement", sessionKeys: [target.sessionKey] },
      });
      expect(
        repairedProjection.snapshot(
          { agentId: "main", key: target.sessionKey },
          {
            includeLastMessage: true,
          },
        ).row,
      ).toMatchObject({ sessionId: "replacement", lastMessagePreview: undefined });
    } finally {
      repairedProjection.dispose();
    }
  });
});

it.each([false, true])(
  "serves session lists during renewal with modelFactsChanged=%s",
  async (modelFactsChanged) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { list: [{ id: "main", default: true }] } };
      const query = { agentId: "main", key: "agent:main:catalog" };
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: query.key },
        {
          sessionId: "catalog",
          updatedAt: 1,
          providerOverride: "unit-test",
          modelOverride: "fixture",
          visibility: "shared",
        },
      );
      const initial = [
        {
          id: "fixture",
          name: "Fixture",
          provider: "unit-test",
          contextWindow: 8192,
          contextTokens: 8192,
        },
      ];
      const replacement = createDeferredCore<typeof initial>();
      const getModelCatalog = vi.fn().mockResolvedValue(initial);
      const release = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({ cfg, getModelCatalog });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const client = identifiedClient("owner@example.com");
      const list = () => listSessions({ context, client, request: {} });
      try {
        await projection.ensureMaterialized();
        const before = projection.materializedCount;
        getModelCatalog.mockReturnValue(replacement.promise);
        notifyPreparedModelRuntimePublication({ phase: "catalog-published", modelFactsChanged });
        expect(projection.dirtyRowCount).toBe(0);
        const response = vi.fn();
        const pendingList = list().then(response);
        // The actual RPC must reply before the deferred catalog is released.
        await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
        await pendingList;
        expect(response.mock.calls[0]![0].sessions).toEqual([
          expect.objectContaining({ key: query.key, contextTokens: 8192 }),
        ]);
        expect(projection.snapshot(query).row?.contextTokens).toBe(8192);
        expect(getModelCatalog).toHaveBeenCalledTimes(modelFactsChanged ? 2 : 1);
        if (modelFactsChanged) {
          const next = [{ ...initial[0]!, contextWindow: 16384, contextTokens: 16384 }];
          replacement.resolve(next);
          await replacement.promise;
          expect(projection.state.modelCatalog).toBe(next);
          expect(projection.dirtyRowCount).toBe(1);
          expect((await list()).sessions).toEqual([
            expect.objectContaining({ key: query.key, contextTokens: 16384 }),
          ]);
          expect(projection.snapshot(query).row?.contextTokens).toBe(16384);
        } else {
          expect(projection.materializedCount).toBe(before);
        }
      } finally {
        replacement.resolve(initial);
        projection.dispose();
        release();
      }
    });
  },
);

it("waits for the first catalog before admitting session reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const catalog = createDeferredCore<[]>();
    const admitted = vi.fn();
    const startup = createSessionRowProjection({ cfg, getModelCatalog: () => catalog.promise });
    void startup.then(admitted);
    try {
      await nextTurn();
      expect(admitted).not.toHaveBeenCalled();
      catalog.resolve([]);
      const projection = await startup;
      expect(projection.state.modelCatalog).toEqual([]);
    } finally {
      catalog.resolve([]);
      (await startup).dispose();
    }
  });
});

it("fences superseded and disposed background catalog reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const initial: [] = [];
    const superseded = createDeferredCore<[]>();
    const current = createDeferredCore<[]>();
    const getModelCatalog = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(superseded.promise)
      .mockReturnValueOnce(current.promise);
    const projection = await createSessionRowProjection({ cfg, getModelCatalog });
    try {
      sessionChanges.emit({ all: true, scope: "catalog" });
      await nextTurn();
      sessionChanges.emit({ all: true, scope: "catalog" });
      superseded.resolve([]);
      await vi.waitFor(() => expect(getModelCatalog).toHaveBeenCalledTimes(3));
      expect(projection.state.modelCatalog).toBe(initial);
      projection.dispose();
      current.resolve([]);
      await nextTurn();
      expect(projection.state.modelCatalog).toBe(initial);
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      superseded.resolve([]);
      current.resolve([]);
      projection.dispose();
    }
  });
});

it("continues backfill queued as the previous batch settles", async () => {
  vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockResolvedValue({});
  const rows = new Map<string, Row>(
    ["first", "second"].map((key) => {
      const entry = { sessionId: key, updatedAt: 1 };
      return [
        key,
        {
          ...create({
            key,
            agentId: "main",
            storeTarget: { agentId: "main", storePath: "unused" },
          }),
          entry,
        },
      ];
    }),
  );
  const published: string[] = [];
  const backfill = createSessionRowProjectionBackfill({
    ready: async () => {},
    read: (id) => rows.get(id),
    current: () => true,
    publish(row) {
      published.push(row.key);
      if (row.key === "first") {
        queueMicrotask(() => backfill.enqueue("second"));
      }
    },
  });
  try {
    backfill.enqueue("first", { all: true, scope: "profiles" });
    backfill.start();
    await nextTurn();
    expect(published).toEqual([]);
    backfill.enqueue("first");
    await vi.waitFor(() => expect(published).toEqual(["first", "second"]));
  } finally {
    backfill.dispose();
  }
});

it("does not revive resident rows after disposal with a topology refresh pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:disposed" },
      { sessionId: "disposed", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({
      cfg: { agents: { list: [{ id: "main", default: true }] } },
    });
    sessionChanges.emit({ all: true, scope: "config" });
    projection.dispose();
    expect(projection.selectEntries()).toEqual([]);
    expect(projection.selectEntries()).toEqual([]);
  });
});

it("preserves a stored fallback model without requiring a terminal transcript", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const key = "agent:main:stored-fallback";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "stored-fallback",
        updatedAt: 1,
        status: "done",
        providerOverride: "unit-test",
        modelOverride: "selected",
        modelProvider: "unit-test",
        model: "fallback",
        fallbackNotice: {
          kind: "active",
          selectedModel: "unit-test/selected",
          activeModel: "unit-test/fallback",
        },
      },
    );
    const projection = await createSessionRowProjection({ cfg });
    try {
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        activeModelProvider: "unit-test",
        activeModel: "fallback",
      });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: "stored-fallback",
          updatedAt: 2,
          status: "done",
          providerOverride: "unit-test",
          modelOverride: "selected",
          modelProvider: "unit-test",
          model: "replacement",
          fallbackNotice: {
            kind: "active",
            selectedModel: "unit-test/selected",
            activeModel: "unit-test/replacement",
          },
        },
      );
      expect(projection.snapshot({ agentId: "main", key }).row).toMatchObject({
        activeModelProvider: "unit-test",
        activeModel: "replacement",
      });
    } finally {
      projection.dispose();
    }
  });
});

it("backfills terminal fallback models and clears previews when the newest message cannot fit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const target = { agentId: "main", sessionKey: "agent:main:fallback", sessionId: "fallback" };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      displayName: "Existing title",
      status: "done",
      lastRunId: "terminal-run",
      providerOverride: "unit-test",
      modelOverride: "selected",
      fallbackNotice: {
        kind: "active" as const,
        selectedModel: "unit-test/selected",
        activeModel: "unit-test/fallback",
      },
    });
    await persistSessionTranscriptTurn(target, {
      messages: [
        {
          message: {
            role: "assistant",
            content: "Finished",
            provider: "unit-test",
            model: "fallback",
            stopReason: "stop",
            __openclaw: { runId: "terminal-run" },
          },
        },
      ],
      touchSessionEntry: false,
    });
    const projection = await createSessionRowProjection({ cfg });
    const query = { agentId: "main", key: target.sessionKey };
    try {
      expect(projection.snapshot(query).row?.activeModel).toBeUndefined();
      await vi.waitFor(() =>
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          activeModelProvider: "unit-test",
          activeModel: "fallback",
          lastMessagePreview: "Finished",
        }),
      );
      await persistSessionTranscriptTurn(target, {
        messages: [{ message: { role: "assistant", content: "x".repeat(70 * 1024) } }],
        touchSessionEntry: false,
      });
      await vi.waitFor(() =>
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          activeModel: undefined,
          lastMessagePreview: undefined,
        }),
      );
    } finally {
      projection.dispose();
    }
  });
});

it("publishes created and moved child relationships before the background drain", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const now = Date.now();
    const first = "agent:main:first-parent",
      second = "agent:main:second-parent",
      child = "agent:main:child";
    for (const key of [first, second, child]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          updatedAt: now,
          ...(key === child ? { parentSessionKey: first } : {}),
        },
      );
    }
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.snapshot({ agentId: "main", key: first }).row?.childSessions).toEqual([
        child,
      ]);
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: child },
        {
          sessionId: child,
          updatedAt: now + 1,
          parentSessionKey: second,
        },
      );
      expect(projection.dirtyRowCount).toBeGreaterThan(0);
      expect(projection.snapshot({ agentId: "main", key: second }).row?.childSessions).toEqual([
        child,
      ]);
      expect(
        projection.snapshot({ agentId: "main", key: first }).row?.childSessions,
      ).toBeUndefined();
      const created = "agent:main:new-child";
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: created },
        {
          sessionId: created,
          updatedAt: now + 2,
          parentSessionKey: second,
        },
      );
      expect(
        projection.snapshot({ agentId: "main", key: second }).row?.childSessions?.toSorted(),
      ).toEqual([child, created]);
    } finally {
      projection.dispose();
    }
  });
});
