import type { OpenClawConfig } from "../config/types.openclaw.js";
import { reconcileHeartbeatMonitorJobs } from "../cron/heartbeat-monitor.js";
import type { CronService } from "../cron/service.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";

export type GatewaySystemJobReconciliationResult =
  | "converged"
  | "lifecycle-deferred"
  | "retry-scheduled"
  | "superseded";

class GatewaySystemJobReconciliationSupersededError extends Error {}

export function createGatewayCronSystemJobReconciler({
  cron,
  scheduler,
  storePath,
  getRuntimeConfig,
  logger,
}: {
  cron: Pick<CronService, "add" | "list" | "remove">;
  scheduler: GatewayScheduler;
  storePath: string;
  getRuntimeConfig: () => OpenClawConfig;
  logger: { warn: (obj: unknown, msg?: string) => void };
}) {
  // Serialize accepted-config convergence; newer requests and stop supersede this tail.
  let systemJobReconcileTail = Promise.resolve<GatewaySystemJobReconciliationResult>("converged");
  let systemJobScope = scheduler.scope();
  let systemJobScopeDrain = Promise.resolve();
  const stopSystemJobReconciliation = () => {
    // A retry can retire its own scope; only external shutdown joins its callback.
    systemJobScopeDrain = Promise.all([systemJobScopeDrain, systemJobScope.stop()]).then(
      () => undefined,
    );
  };
  const reconcileSystemJobs = (): Promise<GatewaySystemJobReconciliationResult> => {
    if (systemJobScope.signal.aborted) {
      return Promise.resolve("superseded");
    }
    stopSystemJobReconciliation();
    const scope = (systemJobScope = scheduler.scope());
    const isCurrent = () => scope === systemJobScope && !scope.signal.aborted;
    const pass = async (): Promise<GatewaySystemJobReconciliationResult> => {
      const cfg = getRuntimeConfig();
      const assertCurrent = () => {
        if (!isCurrent() || cfg !== getRuntimeConfig()) {
          throw new GatewaySystemJobReconciliationSupersededError();
        }
      };
      try {
        const { ok: converged, lifecycleDeferred } = await reconcileHeartbeatMonitorJobs({
          cron,
          cfg,
          logger,
          commitGuard: assertCurrent,
        });
        assertCurrent();
        if (!converged) {
          scope.schedule({
            id: `cron:${storePath}:system-jobs`,
            delayMs: 30_000,
            run: reconcileSystemJobs,
          });
        }
        // A deleting agent cannot accept monitors, but rollback must still retry them.
        return converged
          ? "converged"
          : lifecycleDeferred
            ? "lifecycle-deferred"
            : "retry-scheduled";
      } catch (error) {
        if (!(error instanceof GatewaySystemJobReconciliationSupersededError)) {
          throw error;
        }
        // A no-op accepted replacement may not request another pass. Finish
        // against its config; an explicit newer request or stop owns its own tail.
        return isCurrent() ? await pass() : "superseded";
      }
    };
    systemJobReconcileTail = systemJobReconcileTail.then(pass, pass);
    return systemJobReconcileTail;
  };
  return {
    reconcile: reconcileSystemJobs,
    stop: stopSystemJobReconciliation,
    resume() {
      if (systemJobScope.signal.aborted) {
        systemJobScope = scheduler.scope();
      }
    },
    async drain() {
      const settlements = await Promise.allSettled([systemJobScopeDrain, systemJobReconcileTail]);
      for (const settlement of settlements) {
        if (settlement.status === "rejected") {
          throw settlement.reason;
        }
      }
    },
  };
}
