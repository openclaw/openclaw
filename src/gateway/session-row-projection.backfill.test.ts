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
import {
  appendProjectionMessages as appendTranscript,
  seedProjectionRow as seedTranscriptRow,
} from "./session-row-projection.test-support.js";
import { terminalAssistantMessage } from "./session-row-terminal-message.test-support.js";
import * as transcriptBackfill from "./session-row-transcript-backfill.js";

afterEach(() => vi.restoreAllMocks());

type TranscriptMessage = Parameters<
  typeof persistSessionTranscriptTurn
>[1]["messages"][number]["message"];

const cfg = { agents: { entries: { main: {} } } };
const display = { includeDerivedTitles: true, includeLastMessage: true };
type Projection = Awaited<ReturnType<typeof createTestProjection>>;
type Query = { agentId: string; key: string };

const preview = (projection: Projection, query: Query) =>
  projection.snapshot(query, { includeLastMessage: true }).row;
const withProjectionState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    await run();
  });

async function withStreamingProjection(
  run: (fixture: {
    projection: Projection;
    target: { agentId: string; sessionKey: string; sessionId: string };
    query: Query;
    append: (content: string) => Promise<void>;
    release: () => void;
  }) => Promise<void>,
) {
  await withProjectionState(async () => {
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
      for (const name of ["parent", "stream", "child"]) {
        projection.describe({ agentId: "main", key: `agent:main:${name}` });
      }
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
    expect(preview(projection, query)).toMatchObject({
      lastMessagePreview: "Update 11",
      lastAssistantMessage: { text: "Update 11", timestamp: expect.any(Number) },
    });
    release();
    vi.useRealTimers();
    await nextTurn();
    expect(backfill.mock.calls.filter(([params]) => params.sessionKey === query.key)).toEqual([]);
  });
});

it("enriches a pre-assistant preview cache without changing settings or transcript rows", async ({
  signal,
}) => {
  await withProjectionState(async () => {
    const { target, query } = seedTranscriptRow("older-preview-cache", {
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
    const readTranscript = () =>
      database
        .prepare(
          "SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
        )
        .all(target.sessionId);
    const transcriptRows = readTranscript();
    const readCache = () =>
      database
        .prepare("SELECT row_transcript_json FROM session_windows WHERE session_id = ?")
        .get(target.sessionId)?.row_transcript_json as string | undefined;
    const expectedPreview = {
      lastMessagePreview: "Existing reply",
      lastAssistantMessage: { text: "Existing reply", timestamp: 200 },
    };
    const stored = JSON.parse(readCache() ?? "null") as Record<string, unknown>;
    expect(stored).toMatchObject(expectedPreview);
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
      await projection.ensureMaterialized();
      projection.describe(query);
      await withinTest(enriched, signal);
      expect(preview(projection, query)).toMatchObject({
        displayName: "Existing session setting",
        ...expectedPreview,
      });
    }
    expect(JSON.parse(readCache() ?? "null")).toMatchObject(expectedPreview);
    expect(loadSessionEntry(target)).toEqual(entry);
    expect(getUserPreferences("existing-profile")).toEqual(settings);
    expect(readTranscript()).toEqual(transcriptRows);

    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using reopened = await createTestProjection({ cfg, modelCatalog: [] });
    await reopened.ensureMaterialized();
    expect(preview(reopened, query)).toMatchObject(expectedPreview);
    await nextTurn();
    expect(backfill).not.toHaveBeenCalled();
  });
});

it("backfills assistant absence once and retains it across user appends", async ({ signal }) => {
  await withProjectionState(async () => {
    const { target, query } = seedTranscriptRow("cold-preview");
    await appendTranscript(target, {
      role: "user",
      content: "Cold message",
      timestamp: 100,
    });
    clearStoredSessionRowTranscriptForTest(target);
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using release = holdForeground();
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const published = observeSessionRowBackfill([target.sessionKey], projection, (row) =>
      row.lastMessagePreview === "Cold message" ? row.key : "",
    );
    projection.describe(query);
    release();
    await withinTest(published, signal);
    expect(backfill).toHaveBeenCalledTimes(1);
    await appendTranscript(
      target,
      { role: "user", content: "First followup" },
      { role: "user", content: "Second followup" },
    );
    await projection.ensureMaterialized();
    expect(preview(projection, query)?.lastMessagePreview).toBe("Second followup");
    expect(preview(projection, query)?.lastAssistantMessage).toBeUndefined();
    await nextTurn();
    expect(backfill).toHaveBeenCalledTimes(1);
  });
});

it("keeps the latest visible assistant preview across user followups and clears replaced sessions", async ({
  signal,
}) => {
  await withProjectionState(async () => {
    const { target, query } = seedTranscriptRow("assistant-preview");
    await appendTranscript(
      target,
      { role: "assistant", content: "**Ready** to review", timestamp: 100 },
      { role: "assistant", content: "Hidden answer", display: false, timestamp: 200 },
      { role: "assistant", content: "NO_REPLY", timestamp: 300 },
      { role: "toolResult", content: "Tool result", timestamp: 400 },
      { role: "user", content: "Next question", timestamp: 500 },
    );
    const published = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
      row.lastAssistantMessage?.text === "Ready to review" ? row.key : "",
    );
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    projection.describe(query);
    await withinTest(published, signal);
    expect(preview(projection, query)).toMatchObject({
      lastMessagePreview: "Next question",
      lastAssistantMessage: { text: "Ready to review", timestamp: 100 },
    });
    expect(projection.snapshot(query, {}).row?.lastAssistantMessage).toBeUndefined();
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    const appendAndExpect = async (
      lastMessagePreview: string,
      lastAssistantMessage: { text: string; timestamp: number },
      ...messages: TranscriptMessage[]
    ) => {
      const updated = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
        row.lastMessagePreview === lastMessagePreview &&
        row.lastAssistantMessage?.text === lastAssistantMessage.text
          ? row.key
          : "",
      );
      await appendTranscript(target, ...messages);
      await withinTest(updated, signal);
      const row = preview(projection, query);
      expect(row?.lastMessagePreview).toBe(lastMessagePreview);
      expect(row?.lastAssistantMessage).toEqual(lastAssistantMessage);
      await nextTurn();
      expect(backfill).not.toHaveBeenCalled();
    };
    await appendAndExpect(
      "One more question",
      { text: "Ready to review", timestamp: 100 },
      { role: "user", content: "One more question", timestamp: 700 },
    );
    await appendAndExpect(
      "Batched followup",
      { text: "Batched answer", timestamp: 800 },
      { role: "assistant", content: "Batched answer", timestamp: 800 },
      { role: "user", content: "Batched followup", timestamp: 900 },
    );
    replaceSessionEntrySync(target, { sessionId: "replacement", updatedAt: 2 });
    const replacement = await withReadySessionRows(
      projection,
      () => [query],
      () => preview(projection, query),
    );
    expect(replacement?.lastAssistantMessage).toBeUndefined();
    expect(replacement?.lastMessagePreview).toBeUndefined();
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
        expect(preview(projection, query)).toMatchObject({
          sessionId: "replacement",
          lastMessagePreview: "New session",
        });
      }
    });
  },
);

it("leaves legacy titles to Doctor repair without changing activity", async () => {
  await withProjectionState(async () => {
    const { target, query } = seedTranscriptRow("legacy");
    await appendTranscript(
      target,
      { role: "user", content: "Investigate the slow session query" },
      { role: "assistant", content: "The query is now bounded." },
    );
    const before = loadSessionEntry(target);
    expect(loadSessionEntry(target)?.displayName).toBeUndefined();
    using projection = await createTestProjection({ cfg });
    await projection.ensureMaterialized();
    expect(
      projection.snapshot(query, { includeDerivedTitles: true }).row?.derivedTitle,
    ).toBeUndefined();
    projection.dispose();
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
  });
});

it("serves cached RPC lists while renewing only the changed agent's catalog", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const multiAgentConfig = { agents: { entries: { main: {}, other: {} } } };
    setRuntimeConfigSnapshot(multiAgentConfig);
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
        visibility: "shared",
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
    const getModelCatalog = vi.fn(async () => catalogs);
    using _ = holdForeground();
    using projection = await createTestProjection({
      cfg: multiAgentConfig,
      getModelCatalog,
    });

    await projection.ensureMaterialized();
    const [changed, unchanged] = queries;
    const retained = projection.describe(unchanged)?.materialized;
    expect(retained).toBeDefined();
    expect(projection.snapshot(changed).row?.contextTokens).toBe(8_192);
    const before = projection.materializedCount;
    notifyPreparedModelRuntimePublication({ phase: "catalog-published", modelFactsChanged: false });
    expect(projection.dirtyRowCount).toBe(0);
    await projection.ensureMaterialized();
    expect(getModelCatalog).toHaveBeenCalledTimes(1);
    expect(projection.materializedCount).toBe(before);
    catalogs = new Map([
      ["main", catalog(16_384)],
      ["other", catalog(8_192)],
    ]);
    const renewal = createDeferredCore<typeof catalogs>();
    getModelCatalog.mockReturnValueOnce(renewal.promise);
    try {
      notifyPreparedModelRuntimePublication({
        phase: "catalog-published",
        modelFactsChanged: true,
      });
      const context = bindSessionRowProjection(requestContext(multiAgentConfig), () => projection);
      const client = identifiedClient("owner@example.com");
      const list = () => listSessions({ context, client, request: {} });
      const expectTokens = (result: Awaited<ReturnType<typeof list>>, contextTokens: number) =>
        expect(result.sessions).toEqual(
          expect.arrayContaining([expect.objectContaining({ key: changed.key, contextTokens })]),
        );
      const response = vi.fn();
      const pendingList = list().then(response);
      await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
      await pendingList;
      expectTokens(response.mock.calls[0]![0], 8_192);
      renewal.resolve(catalogs);
      await renewal.promise;
      await projection.ensureMaterialized();
      expectTokens(await list(), 16_384);
      expect(projection.snapshot(changed).row?.contextTokens).toBe(16_384);
      expect(projection.snapshot(unchanged).row?.contextTokens).toBe(8_192);
      expect(projection.describe(unchanged)?.materialized).toBe(retained);
      expect(projection.materializedCount - before).toBe(1);
    } finally {
      renewal.resolve(catalogs);
    }
  });
});

it("waits for initial catalog admission and ignores renewal after disposal", async () => {
  await withProjectionState(async () => {
    const initial: [] = [];
    const first = createDeferredCore<[]>();
    const renewal = createDeferredCore<[]>();
    const getModelCatalog = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(renewal.promise);
    const admitted = vi.fn();
    const startup = createTestProjection({ cfg, getModelCatalog });
    void startup.then(admitted);
    try {
      await nextTurn();
      expect(admitted).not.toHaveBeenCalled();
      first.resolve(initial);
      const projection = await startup;
      expect(projection.state.modelCatalog).toEqual([]);
      sessionChanges.emit({ all: true, scope: "catalog" });
      await nextTurn();
      projection.dispose();
      renewal.resolve([]);
      await nextTurn();
      expect(projection.state.modelCatalog).toBe(initial);
      expect(projection.selectEntries()).toEqual([]);
    } finally {
      first.resolve(initial);
      renewal.resolve([]);
      (await startup).dispose();
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
  await withProjectionState(async () => {
    const { target, query } = seedTranscriptRow("fallback", {
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
    await appendTranscript(target, terminalAssistantMessage("Finished", "fallback"));
    const initial = observeSessionRowBackfill([target.sessionKey]);
    const backfill = vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields");
    using projection = await createTestProjection({ cfg });
    await projection.ensureMaterialized();
    projection.describe(query);

    const expected = {
      activeModelProvider: "unit-test",
      activeModel: "fallback",
      lastMessagePreview: "Finished",
    };
    await withinTest(initial, signal);
    expect(preview(projection, query)).toMatchObject(expected);
    expect(backfill).not.toHaveBeenCalled();
    for (const changed of [{ model: "selected" }, { modelProvider: "recorded-provider" }]) {
      const published = observeSessionRowBackfill([target.sessionKey]);
      replaceSessionEntrySync(target, { ...loadSessionEntry(target)!, ...changed });
      await projection.ensureMaterialized();
      await nextTurn();
      expect(backfill).not.toHaveBeenCalled();
      await withinTest(published, signal);
      expect(preview(projection, query)).toMatchObject(expected);
    }
    const retained = projection.describe(query)!.materialized;
    expect(retained.row.lastMessagePreview).toBe("Finished");
    const appended = observeSessionRowBackfill([target.sessionKey]);
    await appendTranscript(target, { role: "assistant", content: "x".repeat(70 * 1024) });
    await withinTest(appended, signal);
    expect(projection.describe(query)!.materialized.row).not.toHaveProperty("lastMessagePreview");
    expect(retained.row.lastMessagePreview).toBe("Finished");
    const cleared = preview(projection, query);
    expect(cleared?.activeModel).toBeUndefined();
    expect(cleared).not.toHaveProperty("lastMessagePreview");
    expect(cleared).not.toHaveProperty("lastAssistantMessage");
  });
});
