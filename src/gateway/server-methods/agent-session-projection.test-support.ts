import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-run-registry.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import type { GatewaySessionRow } from "../session-utils.types.js";

export function createAgentTestSessionRowProjection(
  getConfig: () => OpenClawConfig,
  session?: { agentId: string; row: GatewaySessionRow },
) {
  return {
    get state() {
      return { rowContext: { projectedAgentRuns: buildProjectedAgentRunIndex() } };
    },
    capture: () => undefined,
    ensureMaterialized: async () => {},
    withPreparedExactRows: async <T>(
      queries: Parameters<SessionRowProjection["withPreparedExactRows"]>[0],
      consume: () => T,
    ): Promise<{ kind: "complete"; value: T }> => {
      queries(getConfig());
      return { kind: "complete", value: consume() };
    },
    snapshot: ({ key, agentId }: { key: string; agentId: string }) => ({
      row: session?.agentId === agentId && session.row.key === key ? session.row : null,
    }),
  };
}
