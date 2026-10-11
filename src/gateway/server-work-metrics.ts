import { areDiagnosticsEnabledForProcess } from "../infra/diagnostic-events.js";
import {
  createGatewayActiveWorkSnapshot,
  type GatewayActiveWorkInspectors,
} from "../infra/gateway-active-work.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  hasGatewayWorkMetricsListeners,
  onGatewayWorkMetricsDemand,
  publishGatewayWorkMetrics,
} from "../infra/gateway-work-metrics.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { runSynchronousWork } from "../shared/synchronous-work.js";
import { createGatewayServerActiveWorkInspectors } from "./server-active-work.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { prepareProjectedSessionList, selectSessionEntries } from "./session-utils-list.js";

/** Share the server's activity view with maintenance and the lifetime-owned exporter source. */
export function startGatewayActiveWork(
  runtime: {
    gatewayRequestContext: GatewayRequestContext;
    registerGatewayLifetimeSidecars: (sidecar: { stop: () => Promise<void> }) => void;
  },
  log: SubsystemLogger,
): Partial<GatewayActiveWorkInspectors> {
  const context = runtime.gatewayRequestContext;
  const inspectors = createGatewayServerActiveWorkInspectors(context);
  runtime.registerGatewayLifetimeSidecars(startGatewayWorkMetrics({ context, inspectors, log }));
  return inspectors;
}

/** Projects existing owner facts after changes; scraping never acquires session rows. */
export function startGatewayWorkMetrics(params: {
  context: GatewayRequestContext;
  inspectors: Partial<GatewayActiveWorkInspectors>;
  log: SubsystemLogger;
}) {
  let stopped = false;
  let dirty = false;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let pending: Promise<void> | undefined;
  let unsubscribeSessionChanges: (() => void) | undefined;
  publishGatewayWorkMetrics(undefined);
  const needed = () => areDiagnosticsEnabledForProcess() && hasGatewayWorkMetricsListeners();

  const refresh = async () => {
    if (!needed()) {
      return;
    }
    const projection = getSessionRowProjection(params.context);
    if (!projection) {
      return;
    }
    await projection.withSelectionPreparation(async () => {
      do {
        await projection.prepareSelection(true);
        if (stopped || !needed() || projection !== getSessionRowProjection(params.context)) {
          return;
        }
      } while (projection.needsSelectionPreparation());
      const { prepared, presentation, filters } = prepareProjectedSessionList({
        projection,
        context: params.context,
        opts: { activeOnly: true, includeGlobal: true, includeUnknown: true },
        now: Date.now(),
        metadataPrepared: true,
      });
      const selection = runSynchronousWork(selectSessionEntries(filters));
      const sessions = { running: 0, queued: 0 };
      for (const [key, entry] of selection.entries) {
        const target = prepared.getTarget(key)!;
        const active = presentation.active(target.key, entry, target.agentId)!;
        sessions[active.status === "queued" ? "queued" : "running"]++;
      }
      const { agentRuns, chatRuns, queuedTurns } = createGatewayActiveWorkSnapshot(
        params.inspectors,
      ).counts;
      publishGatewayWorkMetrics({ sessions, work: { agentRuns, chatRuns, queuedTurns } });
    });
  };
  const changed = () => {
    if (stopped) {
      return;
    }
    if (!needed()) {
      if (unsubscribeSessionChanges) {
        unsubscribeSessionChanges();
        unsubscribeSessionChanges = undefined;
        dirty = false;
        if (scheduled) {
          clearImmediate(scheduled);
          scheduled = undefined;
        }
        publishGatewayWorkMetrics(undefined);
      }
      return;
    }
    unsubscribeSessionChanges ??= sessionChanges.subscribe(changed);
    dirty = true;
    if (scheduled || pending) {
      return;
    }
    scheduled = runInDetachedAsyncContext(() =>
      setImmediate(() => {
        scheduled = undefined;
        dirty = false;
        pending = refresh()
          .catch((error: unknown) => {
            if (!stopped) {
              publishGatewayWorkMetrics(undefined);
              params.log.warn("Live work metric projection failed", { error });
            }
          })
          .finally(() => {
            pending = undefined;
            if (dirty) {
              changed();
            }
          });
      }),
    );
    scheduled.unref();
  };
  const unsubscribeWorkChanges = onGatewayWorkMetricsChanged(changed);
  const unsubscribeDemand = onGatewayWorkMetricsDemand(changed);
  changed();
  return {
    stop: async () => {
      stopped = true;
      unsubscribeSessionChanges?.();
      unsubscribeWorkChanges();
      unsubscribeDemand();
      if (scheduled) {
        clearImmediate(scheduled);
        scheduled = undefined;
      }
      publishGatewayWorkMetrics(undefined);
      await pending;
    },
  };
}
