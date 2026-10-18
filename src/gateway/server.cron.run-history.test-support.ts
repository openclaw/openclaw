import { expect } from "vitest";
import { cronRunLogEntryToDetail } from "../cron/run-history-detail.js";
import { cronStoreKey } from "../cron/store/key.js";
import { recordCronRun } from "../cron/store/run-history.js";

export async function expectCronRunHistoryPages({
  storePath,
  jobId,
  manualRunId,
  request,
}: {
  storePath: string;
  jobId: string;
  manualRunId: unknown;
  request: (params: Record<string, unknown>) => Promise<{ ok: boolean; payload?: unknown }>;
}) {
  const runsRes = await request({ id: jobId, limit: 50 });
  expect(runsRes.ok).toBe(true);
  const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
  expect(Array.isArray(entries)).toBe(true);
  expect((entries as Array<Record<string, unknown>>).at(-1)).toMatchObject({
    jobId,
    jobName: "log test",
    summary: "hello",
    deliveryStatus: "not-requested",
    runId: manualRunId,
  });
  const allRunsRes = await request({
    scope: "all",
    limit: 50,
    statuses: ["ok"],
  });
  expect(allRunsRes.ok).toBe(true);
  const allEntries = (allRunsRes.payload as { entries?: unknown } | null)?.entries;
  expect(Array.isArray(allEntries)).toBe(true);
  expect((allEntries as Array<{ jobId?: unknown }>).some((entry) => entry.jobId === jobId)).toBe(
    true,
  );

  const storeKey = cronStoreKey(storePath);
  const historyTime = Date.now() - 10_000;
  const historyQuery = "status-order fixture";
  for (const [runId, status, offset] of [
    ["error-old", "error", 100],
    ["skip-old", "skipped", 200],
    ["ok-old", "ok", 300],
    ["error-new", "error", 400],
    ["skip-new", "skipped", 500],
    ["ok-new", "ok", 600],
  ] as const) {
    const startedAt = historyTime + offset;
    await recordCronRun({
      storeKey,
      jobId,
      runId,
      agentId: "main",
      startedAt,
      endedAt: startedAt + 1,
      status: status === "error" ? "failed" : status === "skipped" ? "canceled" : "succeeded",
      detail: cronRunLogEntryToDetail(
        {
          action: "finished",
          jobId,
          runId,
          status,
          ts: startedAt + 1,
          runAtMs: startedAt,
          summary: historyQuery,
        },
        { storeKey },
      ),
    });
  }
  for (const { filters, ids, total, nextOffset } of [
    {
      filters: { sortBy: "status", offset: 0 },
      ids: ["error-new", "error-old"],
      total: 6,
      nextOffset: 2,
    },
    {
      filters: { sortBy: "status", offset: 2 },
      ids: ["skip-new", "skip-old"],
      total: 6,
      nextOffset: 4,
    },
    {
      filters: { sortBy: "status", offset: 4 },
      ids: ["ok-new", "ok-old"],
      total: 6,
      nextOffset: null,
    },
    { filters: {}, ids: ["ok-new", "skip-new"], total: 6, nextOffset: 2 },
    {
      filters: { sortBy: "status", sortDir: "asc" },
      ids: ["error-old", "error-new"],
      total: 6,
      nextOffset: 2,
    },
    {
      filters: { sortBy: "status", statuses: ["ok", "skipped"], offset: 1 },
      ids: ["skip-old", "ok-new"],
      total: 4,
      nextOffset: 3,
    },
  ] as const) {
    expect(
      await request({
        id: jobId,
        view: "summary",
        query: historyQuery,
        limit: 2,
        ...filters,
      }),
      JSON.stringify(filters),
    ).toMatchObject({
      ok: true,
      payload: {
        entries: ids.map((runId) => ({ runId })),
        total,
        limit: 2,
        hasMore: nextOffset !== null,
        nextOffset,
      },
    });
  }
  expect(
    await request({
      scope: "all",
      view: "summary",
      query: historyQuery,
      sortBy: "status",
      limit: 2,
    }),
  ).toMatchObject({
    ok: true,
    payload: {
      entries: [{ runId: "error-new" }, { runId: "error-old" }],
      total: 6,
      nextOffset: 2,
    },
  });
}
