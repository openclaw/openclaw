import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import type { AssistantMessage } from "../llm/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { prepareSessionCostUsageRefreshLock } from "./session-cost-usage-cache.sqlite.js";
import {
  readSessionCostUsageRollupEntry,
  readSessionCostUsageRollupRows,
} from "./session-cost-usage-cache.test-support.js";
import {
  loadCostUsageSummary,
  loadCostUsageSummaryFromCache,
  loadSessionCostSummariesFromCache,
} from "./session-cost-usage.js";

it("publishes both bounded reports after queued cold refreshes coalesce without restoring an out-of-window archive", async () => {
  const state = await createOpenClawTestState({ label: "usage-coalesced-reports" });
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: {} } },
    session: { store: storePath, maintenance: { coldStorage: { enabled: true, afterDays: 1 } } },
  };
  const work = new AsyncWorkScope();
  const day = 86_400_000;
  const firstDay = Date.UTC(2026, 1, 1);
  const lastDay = Date.UTC(2026, 1, 3);
  let fakeTimers = false;
  try {
    await state.writeConfig(config);
    for (const [sessionId, timestamp, tokens] of [
      ["coalesced-earlier", firstDay + day / 2, 7],
      ["coalesced-later", lastDay + day / 2, 13],
      ["coalesced-outside", firstDay - 400 * day, 100],
    ] as const) {
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:" + sessionId,
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: timestamp });
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "owned usage fixture" }],
        api: "openai-responses",
        provider: "fixture",
        model: "usage-fixture",
        stopReason: "stop",
        timestamp,
        usage: {
          input: tokens - 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokens,
          cost: {
            input: (tokens - 1) / 1000,
            output: 0.001,
            cacheRead: 0,
            cacheWrite: 0,
            total: tokens / 1000,
          },
        },
      };
      await persistSessionTranscriptTurn(scope, {
        messages: [{ message }],
        touchSessionEntry: false,
      });
      await replaceSessionEntry(scope, {
        ...expectDefined(loadSessionEntry(scope), "coalesced report fixture"),
        updatedAt: 1,
        lastActivityAt: 1,
        lastInteractionAt: 1,
      });
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .updateTable("session_windows")
              .set({ updated_at: 1, transcript_updated_at: 1 })
              .where("session_id", "=", sessionId),
          );
        },
        { agentId: "main", env: state.env },
      );
    }
    await expect(runSessionColdStorageMaintenance({ config })).resolves.toMatchObject({
      archivedTranscripts: 3,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const outside = "coalesced-outside";
    const coldBefore = expectDefined(
      readSessionColdTranscript(database.db, outside),
      "out-of-window cold archive",
    );
    expect(readSessionCostUsageRollupRows("main")).toHaveLength(0);
    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    const later = {
      agentId: "main",
      config,
      dayBucket,
      startMs: lastDay,
      endMs: lastDay + day - 1,
    };
    const earlier = {
      agentId: "main",
      config,
      dayBucket,
      startMs: firstDay,
      endMs: firstDay + day - 1,
    };
    // Hold only the actual zero-delay queue clock until both real reports request refresh.
    // Cost refresh, SQLite, archive restoration and native worker replies are not mocked.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fakeTimers = true;
    const initial = await work.track(() =>
      Promise.all([loadCostUsageSummaryFromCache(later), loadCostUsageSummaryFromCache(earlier)]),
    );
    expect(initial.map((report) => report.totals.totalTokens)).toEqual([0, 0]);
    expect(initial.every((report) => report.cacheStatus?.status === "refreshing")).toBe(true);
    expect(readSessionCostUsageRollupRows("main")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(0);
    // Publication follows the real worker's final host write, not the first partial row.
    // Join the existing producer owner without cancelling it or inventing a wall-time bound.
    await AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => undefined,
    );
    const publishedRows = readSessionCostUsageRollupRows("main");
    expect(
      publishedRows
        .map(
          (row) =>
            expectDefined(parseSqliteSessionFileMarker(row.key), "owned rollup marker").sessionId,
        )
        .toSorted(),
    ).toEqual(["coalesced-earlier", "coalesced-later"]);
    await work.drain();
    const [publishedLater, publishedEarlier] = await Promise.all([
      loadCostUsageSummaryFromCache({ ...later, requestRefresh: false }),
      loadCostUsageSummaryFromCache({ ...earlier, requestRefresh: false }),
    ]);
    expect(publishedLater.totals.totalTokens).toBe(13);
    expect(publishedEarlier.totals.totalTokens).toBe(7);
    expect(publishedLater.daily.map(({ date, totalTokens }) => ({ date, totalTokens }))).toEqual([
      { date: "2026-02-03", totalTokens: 13 },
    ]);
    expect(publishedEarlier.daily.map(({ date, totalTokens }) => ({ date, totalTokens }))).toEqual([
      { date: "2026-02-01", totalTokens: 7 },
    ]);
    expect(publishedLater.cacheStatus?.status).toBe("fresh");
    expect(publishedEarlier.cacheStatus?.status).toBe("fresh");
    const coldAfter = expectDefined(
      readSessionColdTranscript(database.db, outside),
      "unchanged out-of-window archive",
    );
    expect(coldAfter.generation).toBe(coldBefore.generation);
    expect(coldAfter.archive_sha256).toBe(coldBefore.archive_sha256);
    expect(
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<DB>(database.db)
          .selectFrom("transcript_events")
          .selectAll()
          .where("session_id", "=", outside),
      ).rows,
    ).toEqual([]);
  } finally {
    work.beginClose();
    if (fakeTimers) {
      await vi.runOnlyPendingTimersAsync();
    }
    await work.drain();
    if (fakeTimers) {
      vi.useRealTimers();
    }
    await state.cleanup();
  }
});

it("rebuilds a corrupt selected archive rollup while bounded summary work coalesces", async () => {
  const state = await createOpenClawTestState({ label: "usage-selected-archive-rebuild" });
  const storePath = path.join(state.sessionsDir(), "sessions.json");
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: {} } },
    session: { store: storePath, maintenance: { coldStorage: { enabled: true, afterDays: 1 } } },
  };
  const work = new AsyncWorkScope();
  const day = 86_400_000;
  const now = Date.now();
  const startMs = now - day;
  const endMs = now + day;
  const inRangeSessionId = "usage-hot-inrange";
  const archivedSessionId = "usage-old-outofrange";
  const expectedInRangeTokens = 13 + 5;
  let fakeTimers = false;
  try {
    await state.writeConfig(config);
    for (const [sessionId, timestamp, tokens] of [
      [inRangeSessionId, now, 13],
      [archivedSessionId, now - 400 * day, 100],
    ] as const) {
      const scope = {
        agentId: "main",
        sessionId,
        sessionKey: "agent:main:" + sessionId,
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: timestamp });
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "owned usage fixture" }],
        api: "openai-responses",
        provider: "fixture",
        model: "usage-fixture",
        stopReason: "stop",
        timestamp,
        usage: {
          input: tokens - 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: tokens,
          cost: {
            input: (tokens - 1) / 1000,
            output: 0.001,
            cacheRead: 0,
            cacheWrite: 0,
            total: tokens / 1000,
          },
        },
      };
      await persistSessionTranscriptTurn(scope, {
        messages: [{ message }],
        touchSessionEntry: false,
      });
      if (sessionId === archivedSessionId) {
        await replaceSessionEntry(scope, {
          ...expectDefined(loadSessionEntry(scope), "old usage fixture"),
          updatedAt: 1,
          lastActivityAt: 1,
          lastInteractionAt: 1,
        });
        runOpenClawAgentWriteTransaction(
          ({ db }) => {
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .updateTable("session_windows")
                .set({ updated_at: 1, transcript_updated_at: 1 })
                .where("session_id", "=", sessionId),
            );
          },
          { agentId: "main", env: state.env },
        );
      }
    }

    const allHistory = await loadCostUsageSummary({
      agentId: "main",
      config,
      startMs: 0,
      endMs,
      dayBucket: { mode: "utc-offset", utcOffsetMinutes: 0 },
    });
    expect(allHistory.totals.totalTokens).toBe(113);
    const initialRows = readSessionCostUsageRollupRows("main");
    expect(
      initialRows
        .map(
          (row) =>
            expectDefined(parseSqliteSessionFileMarker(row.key), "owned rollup marker").sessionId,
        )
        .toSorted(),
    ).toEqual([archivedSessionId, inRangeSessionId].toSorted());
    const oldRow = expectDefined(
      initialRows.find(
        (row) => parseSqliteSessionFileMarker(row.key)?.sessionId === archivedSessionId,
      ),
      "old session rollup row",
    );
    expect(readSessionCostUsageRollupEntry(oldRow, "main")).toBeDefined();

    await expect(runSessionColdStorageMaintenance({ config })).resolves.toMatchObject({
      archivedTranscripts: 1,
    });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    expect(readSessionColdTranscript(database.db, archivedSessionId)).toBeDefined();
    expect(readSessionColdTranscript(database.db, inRangeSessionId)).toBeUndefined();

    const archivedBeforeCorruption = await loadSessionCostSummariesFromCache({
      agentId: "main",
      config,
      sessions: [{ sessionId: archivedSessionId, sessionFile: oldRow.key }],
      requestRefresh: false,
    });
    expect(archivedBeforeCorruption.summaries[0]?.totalTokens).toBe(100);
    expect(archivedBeforeCorruption.cacheStatus.status).toBe("fresh");

    const corruptLock = prepareSessionCostUsageRefreshLock("main");
    try {
      expect(await corruptLock.acquire()).toBe(true);
      expect(
        await corruptLock.writeRollup([
          {
            rollupId: oldRow.key,
            valueJson: Buffer.from(oldRow.valueJson),
            blob: Uint8Array.from([0]),
            updatedAt: oldRow.updatedAt,
          },
        ]),
      ).toBe(true);
    } finally {
      await corruptLock.release();
    }
    const damagedRow = expectDefined(
      readSessionCostUsageRollupRows("main").find((row) => row.key === oldRow.key),
      "damaged old session rollup row",
    );
    expect(damagedRow.valueJson).toBe(oldRow.valueJson);
    expect(damagedRow.updatedAt).toBe(oldRow.updatedAt);
    expect(readSessionCostUsageRollupEntry(damagedRow, "main")).toBeUndefined();

    const appendedAt = Date.now();
    const appendedTokens = 5;
    const appendedMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "additional in-range usage event" }],
      api: "openai-responses",
      provider: "fixture",
      model: "usage-fixture",
      stopReason: "stop",
      timestamp: appendedAt,
      usage: {
        input: appendedTokens - 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: appendedTokens,
        cost: {
          input: (appendedTokens - 1) / 1000,
          output: 0.001,
          cacheRead: 0,
          cacheWrite: 0,
          total: appendedTokens / 1000,
        },
      },
    };
    await persistSessionTranscriptTurn(
      {
        agentId: "main",
        sessionId: inRangeSessionId,
        sessionKey: "agent:main:" + inRangeSessionId,
        storePath,
      },
      { messages: [{ message: appendedMessage }], touchSessionEntry: false },
    );

    const dayBucket = { mode: "utc-offset" as const, utcOffsetMinutes: 0 };
    // Hold only the actual zero-delay queue clock until both real public reads request refresh.
    // Refresh selection, SQLite, archive restoration and the native worker remain real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fakeTimers = true;
    const [staleAggregate, staleArchived] = await work.track(() =>
      Promise.all([
        loadCostUsageSummaryFromCache({
          agentId: "main",
          config,
          dayBucket,
          startMs,
          endMs,
        }),
        loadSessionCostSummariesFromCache({
          agentId: "main",
          config,
          sessions: [{ sessionId: archivedSessionId, sessionFile: oldRow.key }],
        }),
      ]),
    );
    expect(staleAggregate.cacheStatus?.status).toBe("refreshing");
    expect(staleArchived.cacheStatus.status).toBe("refreshing");

    await vi.advanceTimersByTimeAsync(0);
    // Only the initial coalescing turn is frozen. A bounded full refresh leaves
    // the selected archive for another real queue turn; its scheduler must run
    // while the native worker completes, rather than waiting on a frozen clock.
    vi.useRealTimers();
    fakeTimers = false;
    await AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => undefined,
    );
    await work.drain();

    const rebuiltArchived = await loadSessionCostSummariesFromCache({
      agentId: "main",
      config,
      sessions: [{ sessionId: archivedSessionId, sessionFile: oldRow.key }],
      requestRefresh: false,
    });
    expect(rebuiltArchived.summaries[0]).not.toBeNull();
    expect(rebuiltArchived.summaries[0]?.totalTokens).toBe(100);
    expect(rebuiltArchived.cacheStatus.status).toBe("fresh");
    const rebuiltRow = expectDefined(
      readSessionCostUsageRollupRows("main").find((row) => row.key === oldRow.key),
      "rebuilt old session rollup row",
    );
    expect(readSessionCostUsageRollupEntry(rebuiltRow, "main")).toBeDefined();

    const rebuiltAggregate = await loadCostUsageSummaryFromCache({
      agentId: "main",
      config,
      dayBucket,
      startMs,
      endMs,
      requestRefresh: false,
    });
    expect(rebuiltAggregate.totals.totalTokens).toBe(expectedInRangeTokens);
    expect(rebuiltAggregate.cacheStatus?.status).toBe("fresh");
  } finally {
    work.beginClose();
    if (fakeTimers) {
      await vi.runOnlyPendingTimersAsync();
    }
    await work.drain();
    if (fakeTimers) {
      vi.useRealTimers();
    }
    await state.cleanup();
  }
});
