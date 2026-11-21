import { getRuntimeConfig } from "../config/io.js";
import { resolveCronJobSessionBindings } from "../cron/job-session-bindings.js";
import type { CronJob } from "../cron/types.js";
import type { getChildLogger } from "../logging.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { invalidateSessionAutomationIndex } from "./session-automation-index.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { withPreparedEventRow } from "./session-event-prepared-row.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
} from "./session-request-agent.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

export function createGatewayCronPublisher(params: {
  broadcast: GatewayBroadcastFn;
  getCron: () => Pick<GatewayCronServiceContract, "getDefaultAgentId">;
  resolveGatewayContext?: () => GatewayRequestContext | undefined;
  logger: Pick<ReturnType<typeof getChildLogger>, "warn">;
}) {
  return (previous: CronJob | undefined, next: CronJob | undefined) => {
    invalidateSessionAutomationIndex();
    // Retargeting can remove a reader from the detailed event's new audience.
    params.broadcast("cron.inventory.changed", undefined, { dropIfSlow: true });
    const cron = params.getCron();
    const bindings = new Map<string, { sessionKey: string; agentId: string }>();
    for (const job of [previous, next]) {
      if (job) {
        for (const [key, agentId] of resolveCronJobSessionBindings(job, {
          cfg: getRuntimeConfig(),
          defaultAgentId: cron.getDefaultAgentId(),
        })) {
          bindings.set(`${agentId}\0${key}`, { sessionKey: key, agentId });
        }
      }
    }
    // Badges consume refreshed session rows after their projection has settled.
    for (const { sessionKey, agentId } of bindings.values()) {
      const context = params.resolveGatewayContext?.();
      const projection = getSessionRowProjection(context);
      const publish = () =>
        params.broadcast(
          "sessions.changed",
          { sessionKey, agentId, reason: "cron-binding", ts: Date.now() },
          { dropIfSlow: true },
        );
      if (!projection) {
        publish();
        continue;
      }
      void (async () => {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
        if (params.resolveGatewayContext?.() !== context) {
          return;
        }
        const agentScope = resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey, agentId);
        if (!agentScope) {
          publish();
          return;
        }
        // The idle announcement owns run liveness: a delta client omits unchanged
        // fields, so a key-only payload after a wake would leave hasActiveRun
        // stuck at the phase-end value. Mirror the lifecycle publisher's row
        // preparation so top-level hasActiveRun/activeRunIds travel with it.
        const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = agentScope;
        if (!routingAgentId) {
          publish();
          return;
        }
        const query = { key: sessionKey, agentId: routingAgentId };
        // Committed cron publications settle with the Gateway, not their producer's scope.
        await runOutsideAsyncWorkScope(() =>
          withPreparedEventRow(projection, query, (read, ancestors) => {
            const record = read?.describe(query);
            const sessionRow = record && read?.present(record);
            const activeRunState =
              sessionRow && record
                ? resolveVisibleActiveSessionRunState({
                    storePath: record.storeTarget.storePath,
                    resolveGatewayContext: params.resolveGatewayContext,
                    physicalPaths: projection.physicalPaths,
                    requestedKey: sessionKey,
                    canonicalKey: sessionRow.key,
                    sessionId: sessionRow.sessionId,
                    agentId: routingAgentId,
                    defaultAgentId: compatibilityOwnerAgentId,
                    projectedAgentRunIndex: projection.state.rowContext.projectedAgentRuns,
                  })
                : null;
            params.broadcast(
              "sessions.changed",
              {
                sessionKey,
                ...(eventAgentId ? { agentId: eventAgentId } : {}),
                reason: "cron-binding",
                ts: Date.now(),
                ...buildGatewaySessionSnapshot({
                  sessionRow,
                  agentId: eventAgentId,
                  activeRunState,
                }),
              },
              {
                agentId: routingAgentId,
                dropIfSlow: true,
                ...resolvePrivateSessionEventBroadcastScope(sessionKey, agentScope),
                sessionEventSubscriptionKeys: resolveSessionSubscriptionKeys(
                  sessionKey,
                  routingAgentId,
                  compatibilityOwnerAgentId,
                ),
                ...(read
                  ? {
                      prepareSessionProjection: prepareSessionEventProjection(projection, read, {
                        ancestors,
                        reuseEnvelope: true,
                      }),
                    }
                  : {}),
              },
            );
          }),
        );
      })().catch((error: unknown) =>
        params.logger.warn({ error }, "Cron session publication failed"),
      );
    }
  };
}
