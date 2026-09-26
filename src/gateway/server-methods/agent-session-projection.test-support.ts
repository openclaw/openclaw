import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildProjectedAgentRunIndex } from "../../infra/agent-run-registry.js";
import type { SessionRowReadView } from "../session-row-prepared-read.js";
import type { SessionRowProjection } from "../session-row-projection.js";
import { createSessionRowProjectionFixture } from "../session-row-projection.test-support.js";
import type { GatewaySessionRow } from "../session-utils.types.js";

export function createAgentTestSessionRowProjection(
  getConfig: () => OpenClawConfig,
  session?: { agentId: string; row: GatewaySessionRow },
): SessionRowProjection {
  const projection = createSessionRowProjectionFixture({ cfg: getConfig(), store: {} });
  const fixture: SessionRowProjection = {
    ...projection,
    get state() {
      const cfg = getConfig();
      return {
        ...projection.state,
        cfg,
        policyConfig: cfg,
        rowContext: {
          ...projection.state.rowContext,
          projectedAgentRuns: buildProjectedAgentRunIndex(),
        },
      };
    },
    getPolicyConfig: getConfig,
    capture: () => undefined,
    ensureMaterialized: async () => {},
    withPreparedExactRows: async <T>(
      queries: Parameters<SessionRowProjection["withPreparedExactRows"]>[0],
      consume: (read: SessionRowReadView) => T,
    ): Promise<{ kind: "complete"; value: T }> => {
      queries(getConfig());
      return { kind: "complete", value: consume(fixture) };
    },
    snapshot: ({ key, agentId }: { key: string; agentId: string }) => ({
      row: session?.agentId === agentId && session.row.key === key ? session.row : null,
      lifecycleRunId: undefined,
    }),
  };
  return fixture;
}
