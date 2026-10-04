import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { publishSessionCostUsageUpdated } from "../../infra/session-cost-usage-events.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
  mocks.loadCombinedSessionStoreForGatewayCore.mockReturnValue({
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

  it("does not substitute another agent's transcript for an absent owner transcript", async () => {
    const result = await queryOwnerUsage([mainRow], "opus");
    expectOwnerRow(result, {
      key: "agent:opus:shared",
      agentId: "opus",
      label: undefined,
      tokens: 100,
    });
  });
});
