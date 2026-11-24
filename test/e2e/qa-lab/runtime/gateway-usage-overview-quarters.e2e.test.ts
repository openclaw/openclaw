import path from "node:path";
import { expect, it } from "vitest";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "../../../../src/config/config.js";
import { formatSqliteSessionFileMarker } from "../../../../src/config/sessions/legacy-sqlite-marker.js";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { READ_SCOPE } from "../../../../src/gateway/method-scopes.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../../../src/gateway/test-helpers.listener.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../../src/infra/kysely-sync.js";
import { refreshCostUsageCacheForAgent } from "../../../../src/infra/session-cost-usage-aggregation.js";
import { USAGE_COST_QUARTER_SCOPE } from "../../../../src/infra/session-cost-usage-quarters.js";
import type { DB } from "../../../../src/state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} from "../../../../src/state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../../../../src/test-utils/openclaw-test-state.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";

const TEST_TIMEOUT_MS = 120_000;
// Asia/Kolkata (+05:30) days start at 18:30Z. Each session's usage is known exactly.
const SESSIONS = [
  {
    id: "overview-boundary",
    turns: [
      ["2026-08-03T18:20:00Z", 100],
      ["2026-08-03T18:40:00Z", 20],
    ],
  },
  { id: "overview-morning", turns: [["2026-08-04T06:00:00Z", 300]] },
  { id: "overview-afternoon", turns: [["2026-08-03T10:00:00Z", 4_000]] },
] as const;
const TRUTH = { tokens: 4_420, daily: { "2026-08-03": 4_100, "2026-08-04": 320 } };
const OVERVIEW = {
  agentId: "main",
  startDate: "2026-08-03",
  endDate: "2026-08-04",
  mode: "specific",
  timeZone: "Asia/Kolkata",
  groupBy: "family",
  projection: "overview",
};

it(
  "reports exact usage totals after background backfill of missing quarter rows",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const portClaim = await acquireGatewayE2ePortBlock();
    const { port } = portClaim;
    let unstartedPortClaim: typeof portClaim | undefined = portClaim;
    const token = `gateway-usage-overview-${process.pid}-${process.env.VITEST_POOL_ID ?? "0"}`;
    const state = await createOpenClawTestState({
      label: "gateway-usage-overview-quarters",
      env: isolatedGatewayEnv,
    });
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    const config = {
      agents: {
        defaults: { workspace: state.workspaceDir },
        entries: { main: { workspace: state.workspaceDir } },
      },
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
      plugins: { enabled: false },
      session: {
        store: path.join(state.stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
      },
    } satisfies OpenClawConfig;
    let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    const startGateway = async () => {
      // The first start adopts the reserved claim; restarts reclaim the same port.
      server = await startClaimedGateway(unstartedPortClaim ?? port, () =>
        startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      );
      unstartedPortClaim = undefined;
      client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        scopes: [READ_SCOPE],
        clientDisplayName: "gateway-usage-overview-qa",
        requestTimeoutMs: 30_000,
        timeoutMs: 30_000,
      });
    };
    const stopGateway = async () => {
      if (client) {
        await disconnectGatewayClient(client);
        client = undefined;
      }
      await server?.close({ reason: "gateway usage overview restart" });
      server = undefined;
    };
    const overview = () =>
      client!.request("sessions.usage", OVERVIEW) as Promise<{
        totals: { totalTokens: number; totalCost: number };
        aggregates: { costDaily: Array<{ date: string; totalTokens: number }> };
        cacheStatus: { status: string };
        partial?: { reason: string; message: string };
      }>;
    const expectExact = async () => {
      const result = await overview();
      expect(result.partial).toBeUndefined();
      expect(result.cacheStatus.status).toBe("fresh");
      expect(result.totals.totalTokens).toBe(TRUTH.tokens);
      expect(result.totals.totalCost).toBeCloseTo(TRUTH.tokens / 1000, 10);
      expect(
        Object.fromEntries(result.aggregates.costDaily.map((day) => [day.date, day.totalTokens])),
      ).toEqual(TRUTH.daily);
      const { startDate, endDate, mode, timeZone } = OVERVIEW;
      const readCost = () =>
        client!.request("usage.cost", {
          agentId: "main",
          startDate,
          endDate,
          mode,
          timeZone,
        }) as Promise<{
          totals: { totalTokens: number };
          daily: Array<{ date: string; totalTokens: number }>;
          cacheStatus: { status: string };
        }>;
      const cost = await readCost();
      expect(cost.totals.totalTokens).toBe(TRUTH.tokens);
      expect(Object.fromEntries(cost.daily.map((day) => [day.date, day.totalTokens]))).toEqual(
        TRUTH.daily,
      );
      // Committed quarters can be complete before the refresh owner closes its writer.
      await expect
        .poll(async () => (await readCost()).cacheStatus.status, { timeout: 10_000 })
        .toBe("fresh");
    };
    const sessionFiles = SESSIONS.map(({ id }) =>
      formatSqliteSessionFileMarker({ agentId: "main", sessionId: id, storePath }),
    );

    try {
      await state.writeConfig(config);
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      await captureRuntimeConfigAsyncReader()();
      for (const { id, turns } of SESSIONS) {
        const scope = {
          agentId: "main",
          env: state.env,
          sessionId: id,
          sessionKey: `agent:main:qa:${id}`,
          storePath,
        };
        const startedAt = Date.parse(turns[0][0]);
        await upsertSessionEntryCore(scope, { sessionId: id, startedAt, updatedAt: startedAt });
        await persistSessionTranscriptTurn(scope, {
          expectedSessionId: id,
          messages: turns.map(([at, tokens]) => ({
            now: Date.parse(at),
            message: {
              role: "assistant" as const,
              provider: "openai",
              model: "gpt-5.6-luna",
              content: [{ type: "text" as const, text: "done" }],
              usage: {
                input: tokens,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: tokens,
                cost: {
                  input: tokens / 1000,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: tokens / 1000,
                },
              },
            },
          })),
          touchSessionEntry: false,
          updateMode: "none",
        });
      }
      await expect(
        refreshCostUsageCacheForAgent({ config, agentId: "main", sessionFiles }),
      ).resolves.toBe("refreshed");

      await startGateway();
      await expectExact();
      await stopGateway();

      // An older build leaves month partitions without quarter rows.
      runOpenClawAgentWriteTransaction(
        ({ db }) => {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<Pick<DB, "cache_entries">>(db)
              .deleteFrom("cache_entries")
              .where("scope", "=", USAGE_COST_QUARTER_SCOPE),
          );
        },
        { agentId: "main", env: state.env },
      );
      // One bounded backfill batch runs, then the Gateway restarts mid-backfill.
      const remaining: string[] = [];
      await refreshCostUsageCacheForAgent({
        config,
        agentId: "main",
        maxFiles: 1,
        onRemaining: (files) => remaining.push(...files.map((file) => file.sessionFile)),
      });
      expect(remaining).toHaveLength(2);
      await closeOpenClawAgentDatabasesAsync();

      // Reports return committed coverage while restart backfill advances independently.
      await startGateway();
      await expect.poll(overview, { timeout: 10_000 }).toMatchObject({
        cacheStatus: { status: "fresh" },
        totals: { totalTokens: TRUTH.tokens },
      });
      await expectExact();
      await stopGateway();

      // The backfilled rows persist; the next Gateway answers from them directly.
      await closeOpenClawAgentDatabasesAsync();
      await startGateway();
      await expectExact();
    } finally {
      await stopGateway();
      await unstartedPortClaim?.release();
      await state.cleanup();
    }
  },
);
