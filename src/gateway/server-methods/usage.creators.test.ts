import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { ensureProfileForEmail, linkEmail, setDisplayName } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import type { GatewayClient } from "./types.js";

const mocks = vi.hoisted(() => ({
  discoverAllSessions: vi.fn(),
  loadCombinedSessionStoreForGatewayCore: vi.fn(),
  loadSessionCostSummariesFromCache: vi.fn(),
}));

vi.mock("../session-utils.js", async () => ({
  ...(await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js")),
  loadCombinedSessionStoreForGatewayCore: mocks.loadCombinedSessionStoreForGatewayCore,
}));

vi.mock("../../infra/session-cost-usage.js", async () => ({
  ...(await vi.importActual<typeof import("../../infra/session-cost-usage.js")>(
    "../../infra/session-cost-usage.js",
  )),
  discoverAllSessions: mocks.discoverAllSessions,
  loadSessionCostSummariesFromCache: mocks.loadSessionCostSummariesFromCache,
}));

import { usageHandlers } from "./usage.js";

function fixture(rows: Record<string, SessionEntry>, tokens: Record<string, number>) {
  const config: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
  mocks.loadCombinedSessionStoreForGatewayCore.mockReturnValue({
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
    runtimeConfig = config,
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
        agents: { entries: { main: { default: true } } },
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
