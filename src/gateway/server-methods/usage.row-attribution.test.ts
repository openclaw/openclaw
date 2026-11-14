import { beforeEach, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createUsageOverviewBatchBuilder,
  ROW,
} from "../../infra/session-cost-usage-overview-batch.js";
import { TOTAL_FIELDS } from "../../infra/session-cost-usage-quarters.js";
import type { SessionCostSummary } from "../../infra/session-cost-usage.types.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";

// mock-isolation: The response-row fixture must not load operator configuration.
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => config }));
vi.mock("../../infra/session-cost-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/session-cost-usage.js")>()),
  discoverAllSessions: vi.fn(),
  loadSessionCostSummariesFromCache: vi.fn(),
  loadSessionUsageOverviewFromCache: vi.fn(),
}));
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  loadSessionUsageOverviewFromCache,
} from "../../infra/session-cost-usage.js";
import {
  createUsageSessionStoreFixture,
  freshUsageBatch,
  invokeUsage,
  usageReply,
  usageTotals,
  type UsageSessionStoreFixture,
} from "./usage.test-support.js";

const discovery = vi.mocked(discoverAllSessions);
const summaryLoader = vi.mocked(loadSessionCostSummariesFromCache);
let config: OpenClawConfig = {
  session: {},
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, opus: {} },
  },
};
let projectionFixture: UsageSessionStoreFixture;
beforeEach(() => {
  config = { ...config };
  vi.clearAllMocks();
});
async function readSessionsUsage(params: Record<string, unknown>) {
  const reply = await invokeUsage(
    "sessions.usage",
    { startDate: "2026-02-01", endDate: "2026-02-02", limit: 10, ...params },
    config,
    { rows: projectionFixture },
  );
  const [ok, result] = usageReply(reply);
  expect(ok).toBe(true);
  return result as SessionsUsageResult;
}

it.each(["detail", "overview"] as const)(
  "fills final %s row attribution from dominant measured usage without changing accounting",
  async (projection) => {
    const modelUsage = [
      { provider: "small", model: "small-model", count: 1, totals: usageTotals(10, 0.01) },
      { provider: "large", model: "large-model", count: 1, totals: usageTotals(30, 0.03) },
    ];
    const measured = { ...usageTotals(40, 0.04), firstActivity: 1, modelUsage };
    const cases: Array<{
      id: string;
      stored: Partial<SessionEntry>;
      usage: SessionCostSummary | null;
      provider?: string;
      model?: string;
    }> = [
      { id: "missing", stored: {}, usage: measured, provider: "large", model: "large-model" },
      {
        id: "stored",
        stored: { modelProvider: "saved", model: "saved-model" },
        usage: measured,
        provider: "saved",
        model: "saved-model",
      },
      {
        id: "provider-only",
        stored: { modelProvider: "small" },
        usage: {
          ...measured,
          ...usageTotals(45, 0.045),
          modelUsage: [
            {
              provider: "small",
              model: "other-small-model",
              count: 1,
              totals: usageTotals(5, 0.005),
            },
            ...modelUsage,
          ],
        },
        provider: "small",
        model: "small-model",
      },
      {
        id: "model-only",
        stored: { model: "small-model" },
        usage: {
          ...measured,
          ...usageTotals(45, 0.045),
          modelUsage: [
            { provider: "other", model: "small-model", count: 1, totals: usageTotals(5, 0.005) },
            ...modelUsage,
          ],
        },
        provider: "small",
        model: "small-model",
      },
      {
        id: "provider-unmatched",
        stored: { modelProvider: "saved" },
        usage: measured,
        provider: "saved",
      },
      {
        id: "model-unmatched",
        stored: { model: "saved-model" },
        usage: measured,
        model: "saved-model",
      },
      {
        id: "tie",
        stored: {},
        usage: {
          ...usageTotals(20, 0.02),
          firstActivity: 1,
          modelUsage: [modelUsage[0]!, { ...modelUsage[1]!, totals: usageTotals(10, 0.01) }],
        },
        provider: "small",
        model: "small-model",
      },
      { id: "empty", stored: {}, usage: null },
      { id: "zero", stored: {}, usage: { ...usageTotals(0), modelUsage: [] } },
      {
        id: "null-model-usage",
        stored: {},
        usage: {
          ...usageTotals(0),
          // @ts-expect-error Reporter #198488 observed null; current summaries type only undefined.
          modelUsage: null,
        },
      },
    ];
    const store = Object.fromEntries(
      cases.map(({ id, stored }, index) => [
        `agent:main:${id}`,
        { sessionId: id, updatedAt: 100 - index, ...stored },
      ]),
    );
    projectionFixture = createUsageSessionStoreFixture(
      store,
      Object.keys(store).map((key) => [key, "main"]),
    );
    discovery
      .mockResolvedValueOnce(
        cases.map(({ id }, index) => ({
          sessionId: id,
          sessionFile: `/tmp/${id}.jsonl`,
          mtime: 100 - index,
        })),
      )
      .mockResolvedValueOnce([]);
    if (projection === "detail") {
      summaryLoader.mockImplementationOnce(async ({ sessions }) =>
        freshUsageBatch(
          sessions.map(({ sessionId }) => cases.find(({ id }) => id === sessionId)!.usage),
        ),
      );
    }
    if (projection === "overview") {
      // Exercise the packed worker reply: initial Gateway rows have no inline summary.
      vi.mocked(loadSessionUsageOverviewFromCache).mockImplementationOnce(async ({ families }) => {
        const batch = createUsageOverviewBatchBuilder();
        const computing = families.map(([session]) => {
          const usage = cases.find(({ id }) => id === session?.sessionId)!.usage;
          if (!usage) {
            batch.addEmpty();
            return true;
          }
          const models = usage.modelUsage ?? [];
          const { values, base } = batch.reserveRow({
            days: 0,
            models: models.length,
            tools: 0,
            dayModels: 0,
            hours: false,
          });
          values.set(
            TOTAL_FIELDS.map((field) => usage[field]),
            base + ROW.TOTALS,
          );
          values[base + ROW.FIRST] = usage.firstActivity ?? Number.NaN;
          models.forEach((entry, index) => {
            const offset = base + ROW.HEADER + index * ROW.MODEL_WIDTH;
            values.set(
              [
                batch.intern(entry.provider),
                batch.intern(entry.model),
                entry.count,
                ...TOTAL_FIELDS.map((field) => entry.totals[field]),
              ],
              offset,
            );
          });
          return false;
        });
        return {
          kind: "overview",
          usage: { kind: "packed", batch: batch.finish(), refreshing: false },
          computing,
          summarizing: 0,
          staleSessionFiles: [],
          invalidRows: [],
          cacheStatus: {
            status: "fresh",
            cachedFiles: families.length,
            pendingFiles: 0,
            staleFiles: 0,
          },
        };
      });
    }
    const result = await readSessionsUsage({
      agentScope: "all",
      ...(projection === "overview" ? { projection } : {}),
    });
    expect(result.sessions).toHaveLength(cases.length);
    for (const { id, provider, model } of cases) {
      const row = result.sessions.find((session) => session.sessionId === id)!;
      expect
        .soft({ provider: row.modelProvider, model: row.model }, id)
        .toEqual({ provider, model });
      if (id === "null-model-usage") {
        expect(row.usage?.totalTokens).toBe(0);
        if (projection === "detail") {
          expect(row.usage?.modelUsage).toBeNull();
        }
      }
    }
    expect(result.aggregates.byProvider).toMatchObject([
      { provider: "large", totals: { totalTokens: 190, totalCost: expect.closeTo(0.19) } },
      { provider: "small", totals: { totalTokens: 75, totalCost: expect.closeTo(0.075) } },
      { provider: "other", totals: { totalTokens: 5, totalCost: expect.closeTo(0.005) } },
    ]);
    expect(result.totals).toMatchObject({ totalTokens: 270, totalCost: expect.closeTo(0.27) });
  },
);
