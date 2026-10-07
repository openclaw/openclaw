import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { publishSessionCostUsageUpdated } from "../../infra/session-cost-usage-events.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { linkEmail, setDisplayName } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  discoverAllSessions: vi.fn(),
  loadCombinedSessionStoreForGatewayCoreAsync: vi.fn(),
  loadSessionCostSummariesFromCache: vi.fn(),
}));

vi.mock("../../config/sessions/combined-store-gateway-read.js", async () => ({
  ...(await vi.importActual<typeof import("../../config/sessions/combined-store-gateway-read.js")>(
    "../../config/sessions/combined-store-gateway-read.js",
  )),
  loadCombinedSessionStoreForGatewayCoreAsync: mocks.loadCombinedSessionStoreForGatewayCoreAsync,
}));
vi.mock("../../infra/session-cost-usage.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  )),
  discoverAllSessions: mocks.discoverAllSessions,
  loadSessionCostSummariesFromCache: mocks.loadSessionCostSummariesFromCache,
}));

import { createDeferred } from "../../../test/helpers/promise.js";
import { usageHandlers } from "./usage.js";

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

function sessionSummary(totalTokens: number) {
  return {
    ...createEmptyCostUsageTotals(),
    input: totalTokens,
    totalTokens,
    totalCost: totalTokens / 1000,
    inputCost: totalTokens / 1000,
  };
}

function freshSummaries(sessions: unknown[], tokens = 10) {
  return {
    summaries: sessions.map(() => sessionSummary(tokens)),
    cacheStatus: { status: "fresh", cachedFiles: sessions.length, pendingFiles: 0, staleFiles: 0 },
  };
}

async function runSessionsUsage(
  params: Record<string, unknown>,
  runtimeConfig: OpenClawConfig = config,
  client?: GatewayClient,
  method: "sessions.usage" | "usage.cost" = "sessions.usage",
) {
  const respond = vi.fn();
  const handler = expectDefined(usageHandlers[method], "usage handler");
  await handler({
    respond,
    params,
    client: client ?? null,
    context: { getRuntimeConfig: () => runtimeConfig },
  } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
  expect(respond).toHaveBeenCalledTimes(1);
  if (method === "usage.cost") {
    expect(respond.mock.calls[0]?.[0]).toBe(false);
    return expectDefined(respond.mock.calls[0]?.[2], "usage.cost error");
  }
  expect(respond.mock.calls[0]?.[0]).toBe(true);
  return expectDefined(respond.mock.calls[0]?.[1], "sessions.usage result");
}

type StoredFixture = { key: string; agentId: string; entry: SessionEntry };

function mockStore(rows: StoredFixture[], stateDir: string) {
  const store = Object.fromEntries(rows.map(({ key, entry }) => [key, entry]));
  mocks.loadCombinedSessionStoreForGatewayCoreAsync.mockReturnValue({
    durableTargets: [],
    storePath: "(multiple)",
    store,
    targetsBySessionKey: new Map(
      rows.map(({ key, agentId, entry }) => [
        key,
        {
          agentId,
          entry,
          readSourceEntry: (sourceKey: string) => store[sourceKey],
          resolveSourceKey: (sourceKey: string) => sourceKey,
          storeTarget: {
            agentId,
            storePath: path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
          },
        },
      ]),
    ),
  });
}

async function queryOwnerUsage(rows: StoredFixture[], discoveredAgent: string) {
  return withOpenClawTestState({ label: "usage-owner" }, async ({ stateDir }) => {
    mockStore(rows, stateDir);
    mocks.discoverAllSessions.mockImplementation(async ({ agentId }: { agentId: string }) =>
      agentId === discoveredAgent
        ? [
            {
              sessionId: "shared",
              sessionFile: path.join(stateDir, "agents", agentId, "sessions", "shared.jsonl"),
              mtime: 100,
            },
          ]
        : [],
    );
    mocks.loadSessionCostSummariesFromCache.mockImplementation(
      async ({ sessions, agentId }: { sessions: unknown[]; agentId: string }) =>
        freshSummaries(sessions, agentId === "main" ? 10 : 100),
    );
    return await runSessionsUsage({ range: "all", limit: 10, agentScope: "all" });
  });
}

function expectOwnerRow(
  result: SessionsUsageResult,
  { key, agentId, label, tokens }: { key: string; agentId: string; label?: string; tokens: number },
) {
  expect(result).toMatchObject({
    sessions: [{ key, agentId, label, usage: { totalTokens: tokens } }],
    totals: { totalTokens: tokens },
    aggregates: { byAgent: [{ agentId, totals: { totalTokens: tokens } }] },
  });
}

describe("sessions.usage result cache and owner attribution", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.clearAllMocks();
    config = { ...config };
    mockStore([], "/tmp");
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

  it("partitions usage by role identity and excludes foreign sessions before aggregation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const firstProfile = ensureProfileForEmail("first@example.com");
      const secondProfile = ensureProfileForEmail("second@example.com");
      const roleConfig: OpenClawConfig = {
        ...config,
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      };
      mockStore(
        [firstProfile, secondProfile].map((profile, index) => ({
          key: `agent:main:${index === 0 ? "first" : "second"}`,
          agentId: "main",
          entry: {
            sessionId: `session-${index === 0 ? "first" : "second"}`,
            updatedAt: index === 0 ? 200 : 100,
            createdActor: { type: "human", source: "profile", id: profile.id },
            visibility: "shared",
          },
        })),
        "/tmp",
      );
      mocks.discoverAllSessions.mockResolvedValue([
        { sessionId: "session-first", sessionFile: "/tmp/first.jsonl", mtime: 200 },
        { sessionId: "session-second", sessionFile: "/tmp/second.jsonl", mtime: 100 },
      ]);
      const clientFor = (profileId?: string): GatewayClient => ({
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          role: "operator",
          client: {
            id: profileId ? "openclaw-control-ui" : "gateway-client",
            version: "test",
            platform: "test",
            mode: profileId ? "webchat" : "backend",
          },
          scopes: profileId ? ["operator.read", "operator.write"] : ["operator.read"],
        },
        authenticatedUserProfile: profileId
          ? { profileId, displayName: null, hasAvatar: false, updatedAt: 1 }
          : undefined,
        // Host-internal dispatch carries system authority; clientless operators are denied.
        internal: profileId ? undefined : { operatorRoleActor: { kind: "system" } },
      });
      for (const [profileId, expectedKeys, tokens] of [
        [undefined, ["agent:main:first", "agent:main:second"], 20],
        [firstProfile.id, ["agent:main:first"], 10],
        [secondProfile.id, ["agent:main:second"], 10],
      ] as const) {
        const client = clientFor(profileId);
        const result: SessionsUsageResult = await runSessionsUsage(baseParams, roleConfig, client);
        expect(await runSessionsUsage(baseParams, roleConfig, client)).toEqual(result);
        expect(result.sessions.map(({ key }) => key)).toEqual(expectedKeys);
        expect(result.totals.totalTokens).toBe(tokens);
      }
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(3);

      const deniedCost = await runSessionsUsage(
        baseParams,
        roleConfig,
        clientFor(firstProfile.id),
        "usage.cost",
      );
      expect(deniedCost).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("sessions hidden by your operator role"),
      });
    });
  });

  it("coalesces concurrent cold misses into one aggregation", async () => {
    const held = createDeferred();
    const started = createDeferred();
    mocks.loadSessionCostSummariesFromCache.mockImplementationOnce(
      async ({ sessions }: { sessions: unknown[] }) => {
        started.resolve();
        await held.promise;
        return freshSummaries(sessions);
      },
    );
    const first = runSessionsUsage(baseParams);
    const second = runSessionsUsage(baseParams);
    try {
      await started.promise;
      expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(1);
      held.resolve();
      expect(await second).toEqual(await first);
    } finally {
      held.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it.each(["cold", "stale"])(
    "does not give a %s lower-cache snapshot the 30s freshness TTL",
    async (kind) => {
      mocks.loadSessionCostSummariesFromCache
        .mockResolvedValueOnce({
          summaries: [
            kind === "cold"
              ? null
              : { ...sessionSummary(10), computedAt: 100, staleSince: 200, refreshing: true },
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

  it("invalidates a fresh response immediately when a rollup commits", async () => {
    await runSessionsUsage(baseParams);
    mocks.loadSessionCostSummariesFromCache.mockResolvedValueOnce(freshSummaries([{}], 20));
    publishSessionCostUsageUpdated("main");
    const result = await runSessionsUsage(baseParams);
    expect(result.totals.totalTokens).toBe(20);
    expect(mocks.loadSessionCostSummariesFromCache).toHaveBeenCalledTimes(2);
  });

  const mainRow: StoredFixture = {
    key: "agent:main:telegram:dm",
    agentId: "main",
    entry: { sessionId: "shared", updatedAt: 10, label: "Main chat" },
  };

  it("keeps canonical alias selection within a single owner", async () => {
    const result = await queryOwnerUsage(
      [
        mainRow,
        {
          ...mainRow,
          key: "agent:main:shared",
          entry: { ...mainRow.entry, updatedAt: 1, label: "Canonical main" },
        },
      ],
      "main",
    );
    expectOwnerRow(result, {
      key: "agent:main:shared",
      agentId: "main",
      label: "Canonical main",
      tokens: 10,
    });
  });
});

function fixture(rows: Record<string, SessionEntry>, tokens: Record<string, number>) {
  const creatorConfig: OpenClawConfig = { agents: { entries: { main: {} } } };
  mocks.loadCombinedSessionStoreForGatewayCoreAsync.mockReturnValue({
    store: rows,
    targetsBySessionKey: new Map(
      Object.keys(rows).map((key) => [
        key,
        { agentId: "main", storeTarget: { agentId: "main", storePath: "/tmp/usage.sqlite" } },
      ]),
    ),
    durableTargets: [],
    storePath: "(multiple)",
  });
  mocks.discoverAllSessions.mockResolvedValue(
    Object.keys(tokens).map((sessionId, index) => ({
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      mtime: index + 1,
    })),
  );
  mocks.loadSessionCostSummariesFromCache.mockImplementation(
    async ({ sessions }: { sessions: Array<{ sessionId: string }> }) => ({
      summaries: sessions.map(({ sessionId }) => {
        const totalTokens = tokens[sessionId] ?? 0;
        const totals = {
          ...createEmptyCostUsageTotals(),
          input: totalTokens,
          totalTokens,
          totalCost: totalTokens / 100,
          inputCost: totalTokens / 100,
        };
        return {
          ...totals,
          firstActivity: Date.UTC(2026, 7, 1),
          dailyBreakdown: [
            { date: "2026-08-01", ...totals, tokens: totalTokens, cost: totals.totalCost },
          ],
        };
      }),
      cacheStatus: {
        status: "fresh",
        cachedFiles: sessions.length,
        pendingFiles: 0,
        staleFiles: 0,
      },
    }),
  );
  return async (
    params: Record<string, unknown> = {},
    client: GatewayClient | null = null,
    runtimeConfig = creatorConfig,
  ) => {
    const respond = vi.fn();
    await expectDefined(
      usageHandlers["sessions.usage"],
      "usage handler",
    )({
      params: { range: "all", agentId: "main", limit: 1, ...params },
      respond,
      client,
      context: { getRuntimeConfig: () => runtimeConfig },
    } as unknown as Parameters<(typeof usageHandlers)["sessions.usage"]>[0]);
    expect(respond).toHaveBeenCalledOnce();
    const response = expectDefined(respond.mock.calls[0], "usage response");
    expect(response[0], JSON.stringify(response[2])).toBe(true);
    return response[1] as SessionsUsageResult;
  };
}

const actor = (id: string): SessionEntry["createdActor"] => ({
  type: "human",
  source: "profile",
  id,
});

describe("usage creator attribution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters before the row cap, attributes retained instances, and keeps daily categories in scope", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const ada = ensureProfileForEmail("ada@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      setDisplayName(ada.id, "Ada");
      const query = fixture(
        {
          "agent:main:ada": {
            sessionId: "ada",
            updatedAt: 30,
            createdActor: actor(ada.id),
            usageFamilySessionIds: ["ada-old"],
          },
          "agent:main:bob": { sessionId: "bob", updatedAt: 40, createdActor: actor(bob.id) },
        },
        { "ada-old": 20, ada: 10, bob: 30, orphan: 40 },
      );
      const all = await query();
      expect(all.sessions).toHaveLength(1);
      expect(all.sessions[0]?.sessionId).toBe("bob");
      expect(all.totals.totalTokens).toBe(100);
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
      expect(selected.totals.totalTokens).toBe(30);
      expect(selected.sessions).toMatchObject([
        { sessionId: "ada", creatorKey: adaGroup.key, createdActor: { label: "Ada" } },
      ]);
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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const ada = ensureProfileForEmail("ada@example.test");
      const former = ensureProfileForEmail("former@example.test");
      const query = fixture(
        {
          "agent:main:ada": {
            sessionId: "ada",
            updatedAt: 6,
            createdActor: actor(ada.id),
            owner: { actor: { type: "human", id: former.id } },
          },
          "agent:main:former": {
            sessionId: "former",
            updatedAt: 5,
            createdActor: actor(former.id),
          },
          "agent:main:discord": {
            sessionId: "discord",
            updatedAt: 4,
            createdActor: { type: "human", source: "channel", id: ada.id },
            delivery: normalizeSessionDeliveryState({
              context: { channel: "discord", to: "fixture", accountId: "one" },
            }),
          },
          "agent:main:telegram": {
            sessionId: "telegram",
            updatedAt: 3,
            createdActor: { type: "human", source: "channel", id: ada.id },
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "fixture", accountId: "one" },
            }),
          },
          "agent:main:unqualified": {
            sessionId: "unqualified",
            updatedAt: 2,
            createdActor: { type: "human", source: "channel", id: ada.id },
          },
          "agent:main:system": {
            sessionId: "system",
            updatedAt: 2,
            createdActor: { type: "system" },
          },
        },
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
      expect(selected.sessions.map(({ sessionId }) => sessionId)).toEqual(["ada", "former"]);
      expect(selected.totals.totalTokens).toBe(30);
      expect(new Set(after.creatorOptions?.map(({ key }) => key)).size).toBe(5);
    });
  });

  it("never exposes hidden creators or counts their spend through the selector", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const ada = ensureProfileForEmail("ada@example.test");
      const bob = ensureProfileForEmail("bob@example.test");
      const query = fixture(
        {
          "agent:main:ada": {
            sessionId: "ada",
            updatedAt: 1,
            createdActor: actor(ada.id),
            visibility: "shared",
          },
          "agent:main:bob": {
            sessionId: "bob",
            updatedAt: 2,
            createdActor: actor(bob.id),
            visibility: "shared",
          },
        },
        { ada: 10, bob: 20 },
      );
      const all = await query();
      const hidden = expectDefined(
        all.creatorOptions?.find((creator) => creator.actor?.id === bob.id),
        "Bob creator",
      );
      const client = {
        connect: { scopes: ["operator.read", "operator.write"] },
        authenticatedUserProfile: { profileId: ada.id },
      } as GatewayClient;
      const restrictedConfig: OpenClawConfig = {
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      };
      const restricted = await query({}, client, restrictedConfig);
      expect(restricted.creatorOptions).toMatchObject([{ actor: { id: ada.id } }]);
      expect(restricted.totals.totalTokens).toBe(10);
      const blocked = await query({ creatorKey: hidden.key }, client, restrictedConfig);
      expect(blocked.sessions).toEqual([]);
      expect(blocked.totals.totalTokens).toBe(0);
      expect(blocked.creatorOptions).toEqual(restricted.creatorOptions);
    });
  });
});
