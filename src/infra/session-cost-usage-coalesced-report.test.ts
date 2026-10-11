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
import { readSessionCostUsageRollupRows } from "./session-cost-usage-cache.test-support.js";
import { loadCostUsageSummaryFromCache } from "./session-cost-usage.js";

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
