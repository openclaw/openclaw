import { expectDefined } from "@openclaw/normalization-core";
import { DEFAULT_WORKER_PENDING_BYTES } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { publishSessionCostUsageUpdated } from "../../infra/session-cost-usage-events.js";
import { compactUsageOverviewFamilies } from "../../infra/session-cost-usage-overview-load.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import { workerTaskPoolEntrypoints } from "../../infra/worker-task-pool-runtime.test-support.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type {
  PoolFixtureInput,
  PoolFixtureResult,
} from "../../infra/worker-task-pool.test-support.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail, setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  discoverAllSessions: vi.fn(),
  loadSessionCostSummariesFromCache: vi.fn(),
}));

vi.mock("../../infra/session-cost-usage.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  )),
  discoverAllSessions: mocks.discoverAllSessions,
  loadSessionCostSummariesFromCache: mocks.loadSessionCostSummariesFromCache,
  loadSessionUsageOverviewFromCache: vi.fn(
    async (params: Parameters<typeof overviewFromSessionSummaries>[0]) =>
      (await import("./usage.test-support.js")).overviewFromSessionSummaries(
        params,
        mocks.loadSessionCostSummariesFromCache,
      ),
  ),
}));

import { loadSessionUsageOverviewFromCache } from "../../infra/session-cost-usage.js";
import {
  createUsageSessionStoreFixture,
  freshUsageBatch,
  invokeUsage,
  overviewFromSessionSummaries,
  usageClient,
  usageReply,
  usageRoleConfig,
  usageTotals,
  type UsageSessionStoreFixture,
} from "./usage.test-support.js";

let config: OpenClawConfig = {
  session: {},
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "main" } },
    entries: { main: {}, opus: {} },
  },
};

const baseParams = {
  startDate: "2026-02-01",
  endDate: "2026-02-02",
  limit: 10,
} as const;

function freshSummaries(sessions: unknown[], tokens = 10) {
  return freshUsageBatch(sessions.map(() => usageTotals(tokens, tokens / 1000)));
}

async function runSessionsUsage(
  params: Record<string, unknown>,
  runtimeConfig: OpenClawConfig = config,
  client?: GatewayClient,
  method: "sessions.usage" | "usage.cost" = "sessions.usage",
  rows: UsageSessionStoreFixture & { storePath?: string; agentId?: string } = { store: {} },
) {
  const [ok, payload, error] = usageReply(
    await invokeUsage(method, params, runtimeConfig, { rows, client }),
  );
  expect(ok, JSON.stringify(error)).toBe(method !== "usage.cost");
  return expectDefined(method === "usage.cost" ? error : payload, "usage result");
}

describe("sessions.usage result cache and owner attribution", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.clearAllMocks();
    config = { ...config };
    mocks.discoverAllSessions.mockImplementation(async (params: { agentId?: string }) => [
      {
        sessionId: `session-${params.agentId ?? "unknown"}`,
        sessionFile: `/tmp/${params.agentId ?? "unknown"}.jsonl`,
        mtime: 100,
      },
    ]);
    mocks.loadSessionCostSummariesFromCache.mockImplementation(
      async ({ sessions }: { sessions: unknown[] }) => freshSummaries(sessions),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps process-local incognito metadata in broad usage results", async () => {
    await withOpenClawTestState({ label: "usage-incognito" }, async (state) => {
      const key = "agent:main:dashboard:incognito-usage";
      const sessionId = "private-usage";
      const storePath = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: state.env,
      });
      await replaceSessionEntry(
        { agentId: "main", env: state.env, sessionKey: key, storePath },
        { sessionId, incognito: true, updatedAt: 1_000, label: "Private usage" },
      );
      mocks.discoverAllSessions.mockResolvedValueOnce([
        { sessionId, sessionFile: `sqlite:main:${sessionId}:${storePath}`, mtime: 1_000 },
      ]);
      mocks.loadSessionCostSummariesFromCache.mockResolvedValueOnce(
        freshUsageBatch([{ ...createEmptyCostUsageTotals(), totalTokens: 13 }]),
      );

      const result: SessionsUsageResult = await runSessionsUsage({
        range: "all",
        agentId: "main",
      });
      expect(result).toMatchObject({
        sessions: [{ key, sessionId, label: "Private usage", usage: { totalTokens: 13 } }],
        totals: { totalTokens: 13 },
      });
    });
  });

  it.each(["cold", "stale"])(
    "does not give a %s lower-cache snapshot the 30s freshness TTL",
    async (kind) => {
      mocks.loadSessionCostSummariesFromCache
        .mockResolvedValueOnce({
          summaries: [
            kind === "cold"
              ? null
              : { ...usageTotals(10, 0.01), computedAt: 100, staleSince: 200, refreshing: true },
          ],
          cacheStatus: {
            status: "refreshing",
            cachedFiles: kind === "cold" ? 0 : 1,
            pendingFiles: 1,
            staleFiles: 1,
          },
        })
        .mockResolvedValueOnce(freshSummaries([{}], 20));

      const partial: SessionsUsageResult = await runSessionsUsage(baseParams);
      const refreshed: SessionsUsageResult = await runSessionsUsage(baseParams);

      expect(partial.totals.totalTokens).toBe(kind === "cold" ? 0 : 10);
      if (kind === "cold") {
        expect(partial.sessions[0]).toMatchObject({ usage: null, computing: true });
      } else {
        expect(partial.sessions[0]?.usage).toMatchObject({
          computedAt: 100,
          staleSince: 200,
          refreshing: true,
        });
      }
      expect(refreshed.totals.totalTokens).toBe(20);
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);
    },
  );

  it("shares population facts across pages and filters until an owner publishes new usage", async () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      sessionId: `page-${index + 1}`,
      updatedAt: index + 1,
    }));
    const tokens = Object.fromEntries(entries.map((entry, index) => [entry.sessionId, index + 1]));
    const query = fixture(entries, tokens);
    const first = await query({ projection: "overview", sort: "tokens", sortDirection: "desc" });
    const second = await query({
      projection: "overview",
      sort: "tokens",
      sortDirection: "desc",
      offset: 50,
    });
    expect(first.sessions).toHaveLength(50);
    expect(first.sessions[0]?.sessionId).toBe("page-60");
    expect(second.sessions.map((row) => row.sessionId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `page-${10 - index}`),
    );
    const filtered = await query({ projection: "overview", query: "minTokens:55" });
    expect(filtered.sessions).toHaveLength(6);
    expect(filtered.totals.totalTokens).toBe(345);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(1);
    expect(mocks.discoverAllSessions).toHaveBeenCalledTimes(1);

    tokens["page-1"] = 100;
    publishSessionCostUsageUpdated("main");
    const updated = await query({ projection: "overview", sort: "tokens", sortDirection: "desc" });
    expect(updated.sessions[0]).toMatchObject({ sessionId: "page-1", usage: { totalTokens: 100 } });
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);

    // Context predicates hydrate a different source snapshot, unlike usage-only filters.
    expect((await query({ projection: "overview", query: "has:context" })).sessions).toEqual([]);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(3);
    expect((await query({ projection: "overview" })).sessions).toHaveLength(50);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(3);
  });
});

function fixture(entries: SessionEntry[], tokens: Record<string, number>) {
  const rows = Object.fromEntries(entries.map((entry) => [`agent:main:${entry.sessionId}`, entry]));
  const creatorConfig: OpenClawConfig = { agents: { entries: { main: {} } } };
  mocks.discoverAllSessions.mockResolvedValue(
    Object.keys(tokens).map((sessionId, index) => ({
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      mtime: index + 1,
    })),
  );
  mocks.loadSessionCostSummariesFromCache.mockImplementation(
    async ({ sessions }: { sessions: Array<{ sessionId: string }> }) => {
      const summaries = sessions.map(({ sessionId }) => {
        const totalTokens = tokens[sessionId] ?? 0;
        const totals = usageTotals(totalTokens, totalTokens / 100);
        return {
          ...totals,
          firstActivity: Date.UTC(2026, 7, 1),
          dailyBreakdown: [
            { date: "2026-08-01", ...totals, tokens: totalTokens, cost: totals.totalCost },
          ],
        };
      });
      return freshUsageBatch(summaries);
    },
  );
  return (
    params: Record<string, unknown> = {},
    client: GatewayClient | null = null,
    runtimeConfig = creatorConfig,
  ): Promise<SessionsUsageResult> =>
    runSessionsUsage(
      { range: "all", agentId: "main", limit: 1, ...params },
      runtimeConfig,
      client ?? undefined,
      "sessions.usage",
      { store: rows, agentId: "main", storePath: "/tmp/usage.sqlite" },
    );
}

function channelRow(
  sessionId: string,
  updatedAt: number,
  id: string,
  channel?: string,
): SessionEntry {
  return {
    sessionId,
    updatedAt,
    createdActor: { type: "human", source: "channel", id },
    delivery: channel
      ? normalizeSessionDeliveryState({ context: { channel, to: "fixture", accountId: "one" } })
      : undefined,
  };
}

function ownedRow(
  sessionId: string,
  updatedAt: number,
  profileId: string,
  extra: Partial<SessionEntry> = {},
): SessionEntry {
  return {
    sessionId,
    updatedAt,
    createdActor: { type: "human", source: "profile", id: profileId },
    ...extra,
  };
}

describe("usage creator attribution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters before the row cap, attributes retained instances, and keeps daily categories in scope", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const ada = ensureProfileForEmail("ada@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      setDisplayName(ada.id, "Ada");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const query = fixture(
        [
          ownedRow("ada", 30, ada.id, { usageFamilySessionIds: ["ada-old"] }),
          ownedRow("bob", 40, bob.id),
        ],
        { "ada-old": 20, ada: 10, bob: 30, orphan: 40 },
      );
      const all = await query();
      expect(all).toMatchObject({ sessions: [{ sessionId: "bob" }], totals: { totalTokens: 100 } });
      const adaGroup = expectDefined(
        all.aggregates.byCreator?.find((creator) => creator.actor?.label === "Ada"),
        "Ada creator",
      );
      expect(adaGroup).toMatchObject({
        sessionCount: 2,
        totals: { totalTokens: 30 },
        daily: [{ date: "2026-08-01", input: 30, totalTokens: 30 }],
        sessionActivity: [{ dates: ["2026-08-01"], sessionCount: 2 }],
      });
      expect(all.aggregates.costDaily).toMatchObject([
        { date: "2026-08-01", input: 100, totalTokens: 100, inputCost: 1, totalCost: 1 },
      ]);
      const selected = await query({ creatorKey: adaGroup.key });
      expect(selected).toMatchObject({
        totals: { totalTokens: 30 },
        sessions: [{ sessionId: "ada", creatorKey: adaGroup.key, createdActor: { label: "Ada" } }],
      });
      expect(selected.creatorOptions).toEqual(all.creatorOptions);
      expect(selected.aggregates.costDaily).toMatchObject([
        { input: 30, totalTokens: 30, totalCost: expect.closeTo(0.3) },
      ]);
      expect(
        mocks.loadSessionCostSummariesFromCache.mock.lastCall?.[0].sessions.map(
          (session: { sessionId: string }) => session.sessionId,
        ),
      ).toEqual(["ada", "ada-old"]);
      const bobGroup = expectDefined(
        all.aggregates.byCreator?.find((creator) => creator.actor?.id === bob.id),
        "Bob creator",
      );
      expect((await query({ creatorKey: bobGroup.key })).totals.totalTokens).toBe(30);
      expect((await query()).totals.totalTokens).toBe(100);
      expect(await query({ creatorKey: adaGroup.key })).toEqual(selected);
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(3);
    });
  });

  it("canonicalizes profile merges without conflating channel senders or mutable owners", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const ada = ensureProfileForEmail("ada@example.test");
      const former = ensureProfileForEmail("former@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const query = fixture(
        [
          ownedRow("ada", 6, ada.id, {
            owner: { actor: { type: "human", id: former.id } },
          }),
          ownedRow("former", 5, former.id),
          channelRow("discord", 4, ada.id, "discord"),
          channelRow("telegram", 3, ada.id, "telegram"),
          channelRow("unqualified", 2, ada.id),
          { sessionId: "system", updatedAt: 2, createdActor: { type: "system" } },
        ],
        { ada: 10, former: 20, discord: 30, telegram: 40, system: 50, orphan: 60, unqualified: 5 },
      );
      const before = await query({ limit: 20 });
      expect(before.aggregates.byCreator).toHaveLength(6);
      linkEmail("former@example.test", ada.id);
      setDisplayName(ada.id, "Ada merged");
      const after = await query({ limit: 20 });
      expect(after.aggregates.byCreator).toHaveLength(5);
      const merged = expectDefined(
        after.aggregates.byCreator?.find((creator) => creator.actor?.label === "Ada merged"),
        "merged creator",
      );
      expect(merged).toMatchObject({ sessionCount: 2, totals: { totalTokens: 30 } });
      expect(after.aggregates.byCreator?.find((creator) => !creator.actor)).toMatchObject({
        totals: { totalTokens: 65 },
      });
      const selected = await query({ limit: 20, creatorKey: merged.key });
      expect(selected).toMatchObject({
        sessions: [{ sessionId: "ada" }, { sessionId: "former" }],
        totals: { totalTokens: 30 },
      });
      expect(new Set(after.creatorOptions?.map(({ key }) => key)).size).toBe(5);
    });
  });

  it("never exposes hidden creators or counts their spend through the selector", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const ada = ensureProfileForEmail("ada@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const query = fixture(
        [
          ownedRow("ada", 1, ada.id, { visibility: "shared" }),
          ownedRow("bob", 2, bob.id, { visibility: "shared" }),
        ],
        { ada: 10, bob: 20 },
      );
      const all = await query();
      const hidden = expectDefined(
        all.creatorOptions?.find((creator) => creator.actor?.id === bob.id),
        "Bob creator",
      );
      const client = usageClient(ada.id);
      const roleConfig = usageRoleConfig({ agents: { entries: { main: {} } } });
      for (const [profileId, expectedKeys, tokens] of [
        [undefined, ["agent:main:bob", "agent:main:ada"], 30],
        [ada.id, ["agent:main:ada"], 10],
        [bob.id, ["agent:main:bob"], 20],
      ] as const) {
        const viewer = usageClient(profileId);
        const result = await query({ limit: 20 }, viewer, roleConfig);
        expect(await query({ limit: 20 }, viewer, roleConfig)).toEqual(result);
        expect(result.sessions.map(({ key }) => key)).toEqual(expectedKeys);
        expect(result.totals.totalTokens).toBe(tokens);
      }
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(4);
      expect(await runSessionsUsage(baseParams, roleConfig, client, "usage.cost")).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("sessions hidden by your operator role"),
      });
      const restricted = await query({}, client, roleConfig);
      expect(restricted).toMatchObject({
        creatorOptions: [{ actor: { id: ada.id } }],
        totals: { totalTokens: 10 },
      });
      const blocked = await query({ creatorKey: hidden.key }, client, roleConfig);
      expect(blocked).toMatchObject({ sessions: [], totals: { totalTokens: 0 } });
      expect(blocked.creatorOptions).toEqual(restricted.creatorOptions);
    });
  });
});

it("returns complete overview family usage while other reports occupy worker input capacity", async () => {
  // The detail regression's reservation; one descriptor per instance would not fit.
  const backgroundBytes = 265_155_910;
  const storePath =
    "/tmp/synthetic-usage-admission/retained-team-shaped-session-cost-usage-fixture/agents/opus/agent/openclaw-agent.sqlite";
  const families = [
    { key: "agent:opus:capacity-first", prefix: "capacity-first", count: 6001, tokens: 7 },
    { key: "agent:opus:capacity-second", prefix: "capacity-second", count: 6000, tokens: 11 },
  ];
  mocks.discoverAllSessions.mockResolvedValue(
    families.flatMap(({ prefix, count }) =>
      Array.from({ length: count }, (_, index) => ({
        sessionId: `${prefix}-${index}`,
        sessionFile: `sqlite:opus:${prefix}-${index}:${storePath}`,
        mtime: 1000,
      })),
    ),
  );
  const rows = createUsageSessionStoreFixture(
    Object.fromEntries(
      families.map(({ key, prefix, count }) => [
        key,
        {
          sessionId: `${prefix}-0`,
          updatedAt: 1000,
          usageFamilyKey: key,
          usageFamilySessionIds: Array.from({ length: count }, (_, index) => `${prefix}-${index}`),
        },
      ]),
    ),
    families.map(({ key }) => [key, "opus"] as const),
  );
  const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
    workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
    maxWorkers: 2,
    idleTimeoutMs: 0,
  });
  const release = createDeferred();
  const background = Promise.allSettled([
    pool.run(
      async () => {
        await release.promise;
        return { label: "background usage reports" };
      },
      { inputBytes: backgroundBytes },
    ),
  ]);
  vi.mocked(loadSessionUsageOverviewFromCache).mockImplementationOnce(async (params) => {
    const descriptors = params.families.map((family) =>
      family.map(({ sessionId, sessionFile }) => ({ sessionId, sessionFile })),
    );
    expect(2 * JSON.stringify({ families: descriptors }).length).toBeGreaterThan(
      DEFAULT_WORKER_PENDING_BYTES - backgroundBytes,
    );
    await pool.run(
      { label: "family overview report" },
      { inputBytes: 2 * JSON.stringify(compactUsageOverviewFamilies(params.families)).length },
    );
    return overviewFromSessionSummaries(params, async ({ sessions }) =>
      freshUsageBatch(
        sessions.map(({ sessionId }) =>
          usageTotals(sessionId?.startsWith("capacity-first-") ? 7 : 11),
        ),
      ),
    );
  });
  try {
    const result = (await runSessionsUsage(
      { ...baseParams, agentId: "opus", groupBy: "family", projection: "overview" },
      config,
      undefined,
      "sessions.usage",
      rows,
    )) as SessionsUsageResult;
    expect(result.partial).toBeUndefined();
    expect(result.totals.totalTokens).toBe(6001 * 7 + 6000 * 11);
    expect(
      Object.fromEntries(result.sessions.map((row) => [row.key, row.usage?.totalTokens])),
    ).toEqual({ "agent:opus:capacity-first": 6001 * 7, "agent:opus:capacity-second": 6000 * 11 });
  } finally {
    mocks.discoverAllSessions.mockReset();
    release.resolve();
    await background;
    await pool.close();
  }
});
