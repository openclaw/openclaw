import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.js";
import type { SessionEntry, SessionSystemPromptReport } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { foldUsageOverviewFamilies } from "../../infra/session-cost-usage-overview-load.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import type {
  loadSessionCostSummariesFromCache,
  loadSessionUsageOverviewFromCache,
} from "../../infra/session-cost-usage.js";
import type { SessionCostSummary } from "../../infra/session-cost-usage.types.js";
import type { AssistantMessage } from "../../llm/types.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import type { GatewayClient } from "./types.js";
import { usageHandlers } from "./usage.js";

type ProjectionOptions = Omit<Parameters<typeof createSessionRowProjectionFixture>[0], "cfg">;

export async function invokeUsage(
  method: string,
  params: Record<string, unknown>,
  config: OpenClawConfig,
  options: {
    rows?: ProjectionOptions;
    getRuntimeConfig?: () => OpenClawConfig;
    context?: { getRuntimeConfig: () => OpenClawConfig; sessionRowProjectionOwner?: object };
    client?: GatewayClient | null;
    signal?: AbortSignal;
    respond?: ReturnType<typeof vi.fn>;
    handlers?: typeof usageHandlers;
  } = {},
) {
  const respond = options.respond ?? vi.fn();
  const projection = options.context
    ? undefined
    : createSessionRowProjectionFixture({ cfg: config, store: {}, ...options.rows });
  const handler = expectDefined((options.handlers ?? usageHandlers)[method], "usage handler");
  try {
    await handler({
      req: { type: "req", id: "usage", method },
      params,
      respond,
      client: options.client ?? null,
      signal: options.signal,
      isWebchatConnect: () => false,
      context:
        options.context ??
        bindSessionRowProjection(
          { getRuntimeConfig: options.getRuntimeConfig ?? (() => config) },
          () => projection,
        ),
    } as unknown as Parameters<typeof handler>[0]);
  } finally {
    projection?.dispose();
  }
  return respond;
}

export function usageReply(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledOnce();
  return expectDefined(respond.mock.calls[0], "usage response");
}

export const usageTotals = (totalTokens: number, totalCost = 0) => ({
  ...createEmptyCostUsageTotals(),
  input: totalTokens,
  totalTokens,
  totalCost,
  inputCost: totalCost,
});

export const freshUsageBatch = (summaries: Array<SessionCostSummary | null>) => ({
  summaries,
  cacheStatus: {
    status: "fresh" as const,
    cachedFiles: summaries.length,
    pendingFiles: 0,
    staleFiles: 0,
  },
});

/** Serve overview reads from a per-session summary fixture, folding each family's instances. */
export async function overviewFromSessionSummaries(
  params: Parameters<typeof loadSessionUsageOverviewFromCache>[0],
  load: (
    params: Parameters<typeof loadSessionCostSummariesFromCache>[0],
  ) => ReturnType<typeof loadSessionCostSummariesFromCache>,
): ReturnType<typeof loadSessionUsageOverviewFromCache> {
  const { families, ...rest } = params;
  const loaded = await load({ ...rest, sessions: families.flat() });
  return foldUsageOverviewFamilies(families, {
    ...loaded,
    staleSessionFiles: [],
    invalidRows: [],
  });
}

export const usageMessage = (
  totalTokens: number,
  timestamp: number,
  totalCost = 0.01,
  output = 0,
): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "Recorded usage" }],
  api: "openai-responses",
  provider: "fixture",
  model: "usage-model",
  stopReason: "stop",
  timestamp,
  usage: {
    input: totalTokens - output,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: totalCost, output: 0, cacheRead: 0, cacheWrite: 0, total: totalCost },
  },
});

export const writeUsage = (
  target: Parameters<typeof persistSessionTranscriptTurn>[0],
  cwd: string,
  ...usage: Parameters<typeof usageMessage>
) =>
  persistSessionTranscriptTurn(target, {
    cwd,
    updateMode: "none",
    messages: [{ message: usageMessage(...usage), now: usage[1] }],
  });

export const contextReport = (generatedAt: number, ordinal = 0): SessionSystemPromptReport => ({
  source: "run",
  generatedAt,
  systemPrompt: {
    chars: 100 + ordinal,
    projectContextChars: ordinal,
    nonProjectContextChars: 100,
  },
  injectedWorkspaceFiles: [],
  skills: { promptChars: 65_536, entries: [] },
  tools: { listChars: ordinal, schemaChars: 0, entries: [] },
});

export const usageRoleConfig = (
  base: OpenClawConfig,
  others: "none" | "view" = "none",
): OpenClawConfig => ({
  ...base,
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        guest: { sessions: { others }, agents: "*", scopes: ["operator.read", "operator.write"] },
      },
    },
  },
});

export const usageClient = (profileId?: string): GatewayClient => ({
  connect: gatewayConnect(profileId ? ["operator.read", "operator.write"] : ["operator.read"], {
    id: profileId ? "openclaw-control-ui" : "gateway-client",
    mode: profileId ? "webchat" : "backend",
  }),
  authenticatedUserProfile: profileId ? gatewayProfile(profileId) : undefined,
  // Only host-internal dispatch receives system authority without a profile.
  internal: profileId ? undefined : { operatorRoleActor: { kind: "system" } },
});

export type UsageSessionStoreFixture = Pick<
  Parameters<typeof createSessionRowProjectionFixture>[0],
  "store" | "targetsBySessionKey"
>;

export const createUsageSessionStoreFixture = (
  store: Record<string, SessionEntry>,
  owners: ReadonlyArray<readonly [string, string]>,
  storePathForAgent = (agentId: string) => `/tmp/agents/${agentId}/agent/openclaw-agent.sqlite`,
): UsageSessionStoreFixture => ({
  store,
  targetsBySessionKey: new Map(
    owners.map(([key, agentId]) => [
      key,
      {
        agentId,
        entry: store[key],
        readSourceEntry: (sourceKey: string) => store[sourceKey],
        resolveSourceKey: (sourceKey: string) => sourceKey,
        storeTarget: { agentId, storePath: storePathForAgent(agentId) },
      },
    ]),
  ),
});
