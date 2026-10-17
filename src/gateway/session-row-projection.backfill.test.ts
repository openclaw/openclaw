import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { noteSessionTranscriptHealth } from "../commands/doctor-session-transcripts.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { emitSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "./session-row-backfill.test-support.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { create, identity, type EntryRow } from "./session-row-projection-record.js";
import {
  seedRow,
  watchRowFacts,
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => vi.restoreAllMocks());

function appendTranscript(
  target: Parameters<typeof persistSessionTranscriptTurn>[0],
  ...messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"][number]["message"][]
) {
  return persistSessionTranscriptTurn(target, {
    messages: messages.map((message) => ({ message })),
    touchSessionEntry: false,
  });
}

async function withStreamingProjection(
  run: (fixture: {
    projection: Awaited<ReturnType<typeof createTestProjection>>;
    target: { agentId: string; sessionKey: string; sessionId: string };
    query: { agentId: string; key: string };
    append: (content: string) => Promise<void>;
    release: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
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
    using release = holdForeground();
    using projection = await createTestProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await run({
        projection,
        target,
        query: { agentId: "main", key: target.sessionKey },
        async append(content) {
          await appendTranscript(target, { role: "assistant", content });
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

it("refreshes streaming previews without rematerializing unchanged rows", async () => {
  await withStreamingProjection(async ({ projection, query, append, release }) => {
    const reads: string[] = [];
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    watchRowFacts((owner) => (input) => {
      reads.push(...input.sessionKeys);
      return owner.readRowFacts(input);
    });
    const before = projection.materializedCount;
    await append("Update 1");
    for (let index = 2; index <= 10; index++) {
      await append(`Update ${index}`);
    }
    for (const elapsed of [999, 1]) {
      await vi.advanceTimersByTimeAsync(elapsed);
      await projection.ensureMaterialized();
    }
    await append("Update 11");
    await vi.advanceTimersByTimeAsync(1_000);
    await projection.ensureMaterialized();
    await vi.advanceTimersByTimeAsync(1_000);
    // The counter only increases: this guards every preceding append and timer checkpoint.
    expect(projection.materializedCount - before).toBe(0);
    expect(reads).toEqual([]);
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      lastMessagePreview: "Update 11",
    });
    release();
    vi.useRealTimers();
    await nextTurn();
    expect(backfill.mock.calls.filter(([params]) => params.sessionKey === query.key)).toEqual([]);
  });
});

it("reuses batch transcript facts across row-owner restarts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:batch", sessionId: "batch" };
    const query = { agentId: "main", key: target.sessionKey };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    for (const content of ["First batch", "Second batch"]) {
      await appendTranscript(
        target,
        { role: "user", content: "New request" },
        { role: "assistant", content },
      );
      using projection = await createTestProjection({ cfg, modelCatalog: [] });

      await projection.ensureMaterialized();
      expect(projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview).toBe(
        content,
      );
      await nextTurn();
      expect(backfill).not.toHaveBeenCalled();
    }
  });
});

it("enriches a pre-assistant preview cache without changing settings or transcript rows", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:older-preview-cache",
      sessionId: "older-preview-cache",
    };
    const query = { agentId: target.agentId, key: target.sessionKey };
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 1,
      displayName: "Existing session setting",
    });
    await appendTranscript(
      target,
      { role: "user", content: "Existing question", timestamp: 100 },
      { role: "assistant", content: "Existing reply", timestamp: 200 },
    );
    expect(setUserPreferences("existing-profile", { "ui.themeMode": "dark" }).ok).toBe(true);
    const settings = getUserPreferences("existing-profile");
    const entry = loadSessionEntry(target);
    expect(settings).toEqual({ "ui.themeMode": "dark" });
    expect(entry?.displayName).toBe("Existing session setting");
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteTranscriptReadScope(target)),
    ).db;
    const transcriptRows = database
      .prepare(
        "SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
      )
      .all(target.sessionId);
    const readCache = () =>
      database
        .prepare("SELECT row_transcript_json FROM session_windows WHERE session_id = ?")
        .get(target.sessionId)?.row_transcript_json as string | undefined;
    const stored = JSON.parse(readCache() ?? "null") as Record<string, unknown>;
    expect(stored).toMatchObject({
      lastMessagePreview: "Existing reply",
      lastAssistantMessage: { text: "Existing reply", timestamp: 200 },
    });
    delete stored.lastAssistantMessage;
    database
      .prepare("UPDATE session_windows SET row_transcript_json = ? WHERE session_id = ?")
      .run(JSON.stringify(stored), target.sessionId);
    expect(JSON.parse(readCache() ?? "null")).not.toHaveProperty("lastAssistantMessage");

    const enriched = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
      row.lastAssistantMessage?.text === "Existing reply" ? row.key : "",
    );
    {
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await withinTest(enriched, signal);
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
        displayName: "Existing session setting",
        lastMessagePreview: "Existing reply",
        lastAssistantMessage: { text: "Existing reply", timestamp: 200 },
      });
    }
    expect(JSON.parse(readCache() ?? "null")).toMatchObject({
      lastMessagePreview: "Existing reply",
      lastAssistantMessage: { text: "Existing reply", timestamp: 200 },
    });
    expect(loadSessionEntry(target)).toEqual(entry);
    expect(getUserPreferences("existing-profile")).toEqual(settings);
    expect(
      database
        .prepare(
          "SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
        )
        .all(target.sessionId),
    ).toEqual(transcriptRows);

    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using reopened = await createTestProjection({ cfg, modelCatalog: [] });
    await reopened.ensureMaterialized();
    expect(reopened.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      lastMessagePreview: "Existing reply",
      lastAssistantMessage: { text: "Existing reply", timestamp: 200 },
    });
    await nextTurn();
    expect(backfill).not.toHaveBeenCalled();
  });
});

it("keeps the latest visible assistant preview across user followups and clears replaced sessions", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = {
      agentId: "main",
      sessionKey: "agent:main:assistant-preview",
      sessionId: "assistant-preview",
    };
    const query = { agentId: "main", key: target.sessionKey };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    await persistSessionTranscriptTurn(target, {
      messages: [
        { message: { role: "assistant", content: "**Ready** to review", timestamp: 100 } },
        {
          message: { role: "assistant", content: "Hidden answer", display: false, timestamp: 200 },
        },
        { message: { role: "assistant", content: "NO_REPLY", timestamp: 300 } },
        { message: { role: "toolResult", content: "Tool result", timestamp: 400 } },
        { message: { role: "user", content: "Next question", timestamp: 500 } },
      ],
      touchSessionEntry: false,
    });
    for (let pass = 0; pass < 2; pass++) {
      const published = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
        row.lastAssistantMessage?.text === "Ready to review" ? row.key : "",
      );
      const projection = await createTestProjection({ cfg, modelCatalog: [] });
      try {
        await withinTest(published, signal);
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          lastMessagePreview: "Next question",
          lastAssistantMessage: { text: "Ready to review", timestamp: 100 },
        });
        expect(projection.snapshot(query, {}).row?.lastAssistantMessage).toBeUndefined();
        if (pass === 1) {
          const appended = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
            row.lastAssistantMessage?.text === "Latest answer" ? row.key : "",
          );
          await persistSessionTranscriptTurn(target, {
            messages: [
              { message: { role: "assistant", content: "Latest answer", timestamp: 600 } },
            ],
            touchSessionEntry: false,
          });
          await withinTest(appended, signal);
          expect(
            projection.snapshot(query, { includeLastMessage: true }).row?.lastAssistantMessage,
          ).toEqual({
            text: "Latest answer",
            timestamp: 600,
          });
          const followedUp = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
            row.lastAssistantMessage?.text === "Latest answer" &&
            row.lastMessagePreview === "One more question"
              ? row.key
              : "",
          );
          await persistSessionTranscriptTurn(target, {
            messages: [{ message: { role: "user", content: "One more question", timestamp: 700 } }],
            touchSessionEntry: false,
          });
          await withinTest(followedUp, signal);
          expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
            lastMessagePreview: "One more question",
            lastAssistantMessage: { text: "Latest answer", timestamp: 600 },
          });
          replaceSessionEntrySync(target, { sessionId: "replacement", updatedAt: 2 });
          const replacement = await withReadySessionRows(
            projection,
            () => [query],
            () => projection.snapshot(query, { includeLastMessage: true }).row,
          );
          expect(replacement?.lastAssistantMessage).toBeUndefined();
        }
      } finally {
        projection.dispose();
      }
    }
  });
});

it("refreshes committed metadata and lifecycle marks during a transcript window", async () => {
  await withStreamingProjection(async ({ projection, target, query, append }) => {
    await append("Leading update");
    const before = projection.materializedCount;
    await append("Pending update");
    expect(projection.materializedCount).toBe(before);
    const reads: string[] = [];
    const captured = createDeferredCore();
    const resume = createDeferredCore();
    let pause = false;
    watchRowFacts((owner) => async (input) => {
      reads.push(...input.sessionKeys);
      const result = await owner.readRowFacts(input);
      if (pause) {
        pause = false;
        captured.resolve();
        await resume.promise;
      }
      return result;
    });
    sessionChanges.emit({ all: true, scope: "catalog" });
    await projection.ensureMaterialized();
    expect(reads).toEqual([]);
    reads.length = 0;
    pause = true;
    sessionChanges.emit({ all: true, scope: "catalog", factsInvalidated: true });
    const refreshing = projection.ensureMaterialized();
    try {
      await captured.promise;
      await appendTranscript(target, { role: "assistant", content: "Update during renewal" });
    } finally {
      resume.resolve();
      await refreshing;
    }
    expect(reads.filter((key) => key === target.sessionKey)).toHaveLength(2);
    expect(reads.filter((key) => key !== target.sessionKey)).toHaveLength(2);
    replaceSessionEntrySync(target, {
      sessionId: target.sessionId,
      updatedAt: 2,
      displayName: "Renamed immediately",
      parentSessionKey: "agent:main:parent",
    });
    const renamed = await withReadySessionRows(
      projection,
      () => [query],
      () => projection.snapshot(query).row,
    );
    expect(renamed?.displayName).toBe("Renamed immediately");
    await projection.ensureMaterialized();
    const afterMetadata = projection.materializedCount;
    emitSessionLifecycleEvent({ ...target, reason: "updated" });
    await projection.ensureMaterialized();
    expect(projection.materializedCount).toBeGreaterThan(afterMetadata);
  });
});

it.each(["disposal", "replacement"] as const)(
  "cancels a pending trailing transcript refresh on %s",
  async (change) => {
    await withStreamingProjection(async ({ projection, target, query, append }) => {
      const timers = vi.spyOn(globalThis, "setTimeout");
      const canceled = vi.spyOn(globalThis, "clearTimeout");
      const published = vi.fn();
      projection.onFactsChange(published);
      await append("Leading update");
      const before = projection.materializedCount;
      await append("Pending update");
      expect(projection.materializedCount).toBe(before);
      const trailingTimer =
        timers.mock.results[timers.mock.calls.findIndex(([, delay]) => delay === 1_000)]?.value;
      expect(trailingTimer).toBeDefined();
      if (change === "disposal") {
        projection.dispose();
      } else {
        replaceSessionEntrySync(target, {
          sessionId: "replacement",
          updatedAt: 2,
          displayName: "Replacement",
          parentSessionKey: "agent:main:parent",
        });
        await projection.ensureMaterialized();
        expect(projection.snapshot(query).row?.sessionId).toBe("replacement");
      }
      expect(canceled).toHaveBeenCalledWith(trailingTimer);
      published.mockClear();
      const settled = projection.materializedCount;
      await vi.advanceTimersByTimeAsync(1_000);
      await projection.ensureMaterialized();
      expect(published).not.toHaveBeenCalled();
      expect(projection.materializedCount).toBe(settled);
      if (change === "disposal") {
        expect(settled).toBe(before);
        expect(projection.selectEntries()).toEqual([]);
      } else {
        await persistSessionTranscriptTurn(
          { ...target, sessionId: "replacement" },
          { messages: [{ message: { role: "assistant", content: "New session" } }] },
        );
        await projection.ensureMaterialized();
        expect(projection.materializedCount - settled).toBe(0);
        expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
          sessionId: "replacement",
          lastMessagePreview: "New session",
        });
      }
    });
  },
);

it("eventually fills legacy titles and previews without waiting during startup or changing activity", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const target = { agentId: "main", sessionKey: "agent:main:legacy", sessionId: "legacy" };
    const query = { agentId: "main", key: target.sessionKey };
    const display = { includeDerivedTitles: true, includeLastMessage: true };
    replaceSessionEntrySync(target, { sessionId: target.sessionId, updatedAt: 1 });
    await appendTranscript(
      target,
      { role: "user", content: "Investigate the slow session query" },
      { role: "assistant", content: "The query is now bounded." },
    );
    clearStoredSessionRowTranscriptForTest(target);
    const before = loadSessionEntry(target);
    using release = holdForeground();
    using projection = await createTestProjection({ cfg });
    const backfilled = observeSessionRowBackfill([target.sessionKey], projection);
    expect(loadSessionEntry(target)?.displayName).toBeUndefined();
    release();
    await withinTest(backfilled, signal);
    expect(projection.snapshot(query, display).row).toMatchObject({
      lastMessagePreview: "The query is now bounded.",
    });
    expect(loadSessionEntry(target)).toEqual(before);
    expect(
      projection.snapshot(query, { includeDerivedTitles: true }).row?.derivedTitle,
    ).toBeUndefined();
    projection.dispose();
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
    using repairedProjection = await createTestProjection({ cfg });

    expect(repairedProjection.snapshot(query, display).row).toMatchObject({
      derivedTitle: "Investigate the slow session query",
      lastMessagePreview: "The query is now bounded.",
    });
    replaceSessionEntrySync(target, { sessionId: "replacement", updatedAt: 2 });
    const replacement = await withReadySessionRows(
      repairedProjection,
      () => [query],
      () => repairedProjection.snapshot(query, { includeLastMessage: true }).row,
    );
    expect(replacement).toMatchObject({
      sessionId: "replacement",
    });
    expect(replacement?.lastMessagePreview).toBeUndefined();
  });
});

it.each([false, true])(
  "serves session lists during renewal with modelFactsChanged=%s",
  async (modelFactsChanged) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const query = { agentId: "main", key: "agent:main:catalog" };
      seedRow(query.key, {
        sessionId: "catalog",
        updatedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "fixture",
        visibility: "shared",
      });
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
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, getModelCatalog });
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
        expect(response.mock.calls[0]![0].sessions).toMatchObject([
          { key: query.key, contextTokens: 8192 },
        ]);
        expect(projection.snapshot(query).row?.contextTokens).toBe(8192);
        expect(getModelCatalog).toHaveBeenCalledTimes(modelFactsChanged ? 2 : 1);
        if (modelFactsChanged) {
          const next = [{ ...initial[0]!, contextWindow: 16384, contextTokens: 16384 }];
          replacement.resolve(next);
          await replacement.promise;
          expect(projection.state.modelCatalog).toBe(next);
          expect(projection.dirtyRowCount).toBe(1);
          expect((await list()).sessions).toMatchObject([{ key: query.key, contextTokens: 16384 }]);
          expect(projection.snapshot(query).row?.contextTokens).toBe(16384);
        } else {
          expect(projection.materializedCount).toBe(before);
        }
      } finally {
        replacement.resolve(initial);
      }
    });
  },
);

it("updates one agent's catalog without rematerializing another agent's session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {}, other: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const queries = [
      { agentId: "main", key: "agent:main:catalog-owner" },
      { agentId: "other", key: "agent:other:catalog-owner" },
    ] as const;
    for (const query of queries) {
      seedRow(query, {
        sessionId: `${query.agentId}-catalog-owner`,
        updatedAt: 1,
        providerOverride: "unit-test",
        modelOverride: "fixture",
      });
    }
    const pluginRegistry = createEmptyPluginRegistry();
    const metadataSnapshot = createPluginMetadataSnapshotFixture();
    const catalog = (contextTokens: number) =>
      createPreparedGatewayModelCatalog({
        entries: [{ provider: "unit-test", id: "fixture", name: "Fixture", contextTokens }],
        pluginRegistry,
        metadataSnapshot,
      });
    let catalogs = new Map([
      ["main", catalog(8_192)],
      ["other", catalog(8_192)],
    ]);
    using _ = holdForeground();
    using projection = await createTestProjection({ cfg, getModelCatalog: async () => catalogs });

    await projection.ensureMaterialized();
    const [changed, unchanged] = queries;
    const retained = projection.describe(unchanged)?.materialized;
    expect(retained).toBeDefined();
    expect(projection.snapshot(changed).row?.contextTokens).toBe(8_192);
    const before = projection.materializedCount;
    catalogs = new Map([
      ["main", catalog(16_384)],
      ["other", catalog(8_192)],
    ]);
    notifyPreparedModelRuntimePublication({
      phase: "catalog-published",
      modelFactsChanged: true,
    });
    await projection.ensureMaterialized();
    expect(projection.snapshot(changed).row?.contextTokens).toBe(16_384);
    expect(projection.snapshot(unchanged).row?.contextTokens).toBe(8_192);
    expect(projection.describe(unchanged)?.materialized).toBe(retained);
    expect(projection.materializedCount - before).toBe(1);
  });
});

it("waits for the first catalog before admitting session reads", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const catalog = createDeferredCore<[]>();
    const admitted = vi.fn();
    const startup = createTestProjection({ cfg, getModelCatalog: () => catalog.promise });
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

it("does not adopt a background catalog after disposal", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const initial: [] = [];
    const current = createDeferredCore<[]>();
    const getModelCatalog = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(current.promise);
    using projection = await createTestProjection({ cfg, getModelCatalog });
    try {
      sessionChanges.emit({ all: true, scope: "catalog" });
      await nextTurn();
      projection.dispose();
      current.resolve([]);
      await nextTurn();
      expect(projection.state.modelCatalog).toBe(initial);
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      current.resolve([]);
    }
  });
});

it.for(["ready", "readiness failure"])(
  "continues backfill as the previous batch settles (%s)",
  async (mode, { signal }) => {
    const reads = vi
      .spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields")
      .mockResolvedValue({});
    const rows = new Map<string, EntryRow>(
      ["first", "second"].map((key) => [
        key,
        {
          ...create({
            key,
            agentId: "main",
            storeTarget: { agentId: "main", storePath: "unused" },
          }),
          entry: { sessionId: key, updatedAt: 1 },
        },
      ]),
    );
    const published: string[] = [];
    const paused = createDeferredCore();
    const completed = createDeferredCore();
    let rejectNext = mode === "readiness failure";
    const backfill = createSessionRowProjectionBackfill({
      ready: async () => {
        if (rejectNext) {
          rejectNext = false;
          paused.resolve();
          throw new Error("Row facts temporarily unavailable");
        }
      },
      read: (id) => [...rows.values()].find((row) => identity(row) === id),
      current: () => true,
      publish(row) {
        published.push(row.key);
        if (row.key === "first") {
          queueMicrotask(() => backfill.prepare(rows.get("second")!, undefined));
        } else {
          completed.resolve();
        }
      },
    });
    try {
      backfill.start();
      backfill.prepare(rows.get("first")!, undefined);
      if (mode !== "ready") {
        await withinTest(paused.promise, signal);
        await nextTurn();
        const row = rows.get("first")!;
        row.entry = { ...row.entry, displayName: "Renamed while waiting" };
        backfill.prepare(row, undefined);
        await nextTurn();
        expect(published).toContain("first");
      }
      await withinTest(completed.promise, signal);
      expect(published).toEqual(["first", "second"]);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      backfill.dispose();
    }
  },
);

it("backfills terminal fallback models and clears previews when the newest message cannot fit", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
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
    await appendTranscript(target, {
      role: "assistant",
      content: "Finished",
      provider: "unit-test",
      model: "fallback",
      stopReason: "stop",
      __openclaw: { runId: "terminal-run" },
    });
    const initial = observeSessionRowBackfill([target.sessionKey]);
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using projection = await createTestProjection({ cfg });
    const query = { agentId: "main", key: target.sessionKey };

    const expected = {
      activeModelProvider: "unit-test",
      activeModel: "fallback",
      lastMessagePreview: "Finished",
    };
    await withinTest(initial, signal);
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject(expected);
    expect(backfill).not.toHaveBeenCalled();
    for (const changed of [{ model: "selected" }, { modelProvider: "recorded-provider" }]) {
      const published = observeSessionRowBackfill([target.sessionKey]);
      replaceSessionEntrySync(target, { ...loadSessionEntry(target)!, ...changed });
      await projection.ensureMaterialized();
      await nextTurn();
      expect(backfill).not.toHaveBeenCalled();
      await withinTest(published, signal);
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject(expected);
    }
    const appended = observeSessionRowBackfill([target.sessionKey]);
    await appendTranscript(target, { role: "assistant", content: "x".repeat(70 * 1024) });
    await withinTest(appended, signal);
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
      activeModel: undefined,
      lastMessagePreview: undefined,
      lastAssistantMessage: undefined,
    });
  });
});
