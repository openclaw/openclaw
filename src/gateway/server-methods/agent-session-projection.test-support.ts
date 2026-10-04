import { expectDefined } from "@openclaw/normalization-core/expect";
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
  const projection = createSessionRowProjectionFixture({
    cfg: getConfig(),
    agentId: session?.agentId,
    store: session
      ? {
          [session.row.key]: {
            sessionId: expectDefined(session.row.sessionId, "fixture session identity"),
            updatedAt: expectDefined(session.row.updatedAt, "fixture session timestamp"),
          },
        }
      : {},
  });
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
    describe: (query, captured) =>
      session?.agentId === query.agentId && session.row.key === query.key
        ? projection.describe(query, captured)
        : undefined,
    present: (record, options) =>
      session?.agentId === record.agentId && session.row.key === record.key
        ? session.row
        : projection.present(record, options),
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
