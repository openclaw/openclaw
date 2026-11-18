import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
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
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { getUserPreferences, setUserPreferences } from "../state/user-preferences.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "./session-row-backfill.test-support.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjectionBackfill } from "./session-row-projection-backfill.js";
import { create, identity, type EntryRow } from "./session-row-projection-record.js";
import {
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

it("enriches a pre-assistant preview cache without changing settings or transcript rows", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const { target, query } = seedTranscriptRow("older-preview-cache", {
      displayName: "Existing session setting",
    });
    await appendTranscript(
      target,
      { role: "user", content: "Existing question", timestamp: 100 },
      {
        role: "assistant",
        content: "| Color | Hex |\n| --- | --- |\n| Blue | #0000ff |",
        timestamp: 200,
      },
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
    const preview = {
      lastMessagePreview: "Color Hex Blue #0000ff",
      lastAssistantMessage: { text: "Color Hex Blue #0000ff", timestamp: 200 },
    };
    const stored = JSON.parse(readCache() ?? "null") as Record<string, unknown>;
    expect(stored).toMatchObject(preview);
    delete stored.lastAssistantMessage;
    database
      .prepare("UPDATE session_windows SET row_transcript_json = ? WHERE session_id = ?")
      .run(JSON.stringify(stored), target.sessionId);
    expect(JSON.parse(readCache() ?? "null")).not.toHaveProperty("lastAssistantMessage");

    const enriched = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
      row.lastAssistantMessage?.text === "Color Hex Blue #0000ff" ? row.key : "",
    );
    {
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      projection.describe(query);
      await withinTest(enriched, signal);
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject({
        displayName: "Existing session setting",
        ...preview,
      });
    }
    expect(JSON.parse(readCache() ?? "null")).toMatchObject(preview);
    expect(loadSessionEntry(target)).toEqual(entry);
    expect(getUserPreferences("existing-profile")).toEqual(settings);
    expect(readTranscript()).toEqual(transcriptRows);

    using reopened = await createTestProjection({ cfg, modelCatalog: [] });
    await reopened.ensureMaterialized();
    expect(reopened.snapshot(query, { includeLastMessage: true }).row).toMatchObject(preview);
    await nextTurn();
  });
});

it.for([false, true])(
  "backfills an unknown assistant fact once and retains it across user appends (assistant: %s)",
  async (hasAssistant, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      const { target, query } = seedTranscriptRow("cold-preview");
      await appendTranscript(target, {
        role: hasAssistant ? "assistant" : "user",
        content: "Cold message",
        timestamp: 100,
      });
      clearStoredSessionRowTranscriptForTest(target);
      using release = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      const published = observeSessionRowBackfill([target.sessionKey], projection, (row) =>
        row.lastMessagePreview === "Cold message" ? row.key : "",
      );
      projection.describe(query);
      release();
      await withinTest(published, signal);
      await appendTranscript(
        target,
        { role: "user", content: "First followup" },
        { role: "user", content: "Second followup" },
      );
      await projection.ensureMaterialized();
      expect(projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview).toBe(
        "Second followup",
      );
      expect(
        projection.snapshot(query, { includeLastMessage: true }).row?.lastAssistantMessage,
      ).toEqual(hasAssistant ? { text: "Cold message", timestamp: 100 } : undefined);
      await nextTurn();
    });
  },
);

it("keeps the latest visible assistant preview across user followups and clears replaced sessions", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
    const { target, query } = seedTranscriptRow("assistant-preview");
    await appendTranscript(
      target,
      { role: "assistant", content: "**Ready** to review", timestamp: 100 },
      { role: "assistant", content: "Hidden answer", display: false, timestamp: 200 },
      { role: "assistant", content: "NO_REPLY", timestamp: 300 },
      { role: "toolResult", content: "Tool result", timestamp: 400 },
      { role: "user", content: "Next question", timestamp: 500 },
    );
    for (let pass = 0; pass < 2; pass++) {
      const published = observeSessionRowBackfill([target.sessionKey], undefined, (row) =>
        row.lastAssistantMessage?.text === "Ready to review" ? row.key : "",
      );
      const projection = await createTestProjection({ cfg, modelCatalog: [] });
      try {
        await projection.ensureMaterialized();
        projection.describe(query);
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
          await appendTranscript(target, {
            role: "assistant",
            content: "Latest answer",
            timestamp: 600,
          });
          await withinTest(appended, signal);
          expect(
            projection.snapshot(query, { includeLastMessage: true }).row?.lastAssistantMessage,
          ).toEqual({
            text: "Latest answer",
            timestamp: 600,
          });
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
            const row = projection.snapshot(query, { includeLastMessage: true }).row;
            expect(row?.lastMessagePreview).toBe(lastMessagePreview);
            expect(row?.lastAssistantMessage).toEqual(lastAssistantMessage);
            await nextTurn();
          };
          await appendAndExpect(
            "One more question",
            { text: "Latest answer", timestamp: 600 },
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

it.each(["disposal", "replacement"] as const)(
  "cancels a pending trailing transcript refresh on %s",
  async (change) => {
    await withStreamingProjection(async ({ projection, target, query, append }) => {
      const published = vi.fn();
      projection.onFactsChange(published);
      await append("Leading update");
      const before = projection.materializedCount;
      await append("Pending update");
      expect(projection.materializedCount).toBe(before);
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
    setRuntimeConfigSnapshot(cfg);
    const { target, query } = seedTranscriptRow("legacy");
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
    await projection.ensureMaterialized();
    projection.describe(query);
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

it.for(["ready", "readiness failure"])(
  "continues backfill as the previous batch settles (%s)",
  async (mode, { signal }) => {
    vi.spyOn(transcriptBackfill, "backfillSessionRowTranscriptFields").mockResolvedValue({});
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
    } finally {
      backfill.dispose();
    }
  },
);

it("backfills terminal fallback models and clears previews when the newest message cannot fit", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot(cfg);
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
    using projection = await createTestProjection({ cfg });
    await projection.ensureMaterialized();
    projection.describe(query);

    const expected = {
      activeModelProvider: "unit-test",
      activeModel: "fallback",
      lastMessagePreview: "Finished",
    };
    await withinTest(initial, signal);
    expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject(expected);
    for (const changed of [{ model: "selected" }, { modelProvider: "recorded-provider" }]) {
      const published = observeSessionRowBackfill([target.sessionKey]);
      replaceSessionEntrySync(target, { ...loadSessionEntry(target)!, ...changed });
      await projection.ensureMaterialized();
      await nextTurn();
      await withinTest(published, signal);
      expect(projection.snapshot(query, { includeLastMessage: true }).row).toMatchObject(expected);
    }
    const retained = projection.describe(query)!.materialized;
    expect(retained.row.lastMessagePreview).toBe("Finished");
    const appended = observeSessionRowBackfill([target.sessionKey]);
    await appendTranscript(target, { role: "assistant", content: "x".repeat(70 * 1024) });
    await withinTest(appended, signal);
    expect(projection.describe(query)!.materialized.row).not.toHaveProperty("lastMessagePreview");
    expect(retained.row.lastMessagePreview).toBe("Finished");
    const cleared = projection.snapshot(query, { includeLastMessage: true }).row;
    expect(cleared?.activeModel).toBeUndefined();
    expect(cleared).not.toHaveProperty("lastMessagePreview");
    expect(cleared).not.toHaveProperty("lastAssistantMessage");
  });
});
