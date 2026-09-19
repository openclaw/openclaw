import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { createDeferredCore } from "../shared/deferred.js";

export type GatewayPluginReloadStatus = Readonly<{
  phase: "reloading" | "recovering" | "failed";
  pluginIds: string[];
  deadlineAtMs?: number;
  reason?: string;
}>;

export type GatewayPluginRuntimeClaim = Readonly<{
  isCurrent: () => boolean;
  waitForUnblocked: () => Promise<boolean>;
  publish: (publication: () => void) => boolean;
}>;

type GatewayPluginRuntimeReservation = Readonly<{
  claim: GatewayPluginRuntimeClaim;
  commit: () => void;
  reject: () => void;
  setReloadStatus: (status: GatewayPluginReloadStatus | undefined) => void;
  finishReload: (
    outcome: "applied" | "restored" | "failed" | "unchanged",
    pluginIds: ReadonlySet<string>,
    registry: PluginRegistry,
    reportFailure?: (reason: string) => void,
  ) => void;
}>;

/** One Gateway owner fences every plugin publication across startup and hot replacement. */
export function createGatewayPluginRuntimeGeneration(params: {
  getServices: () => PluginServicesHandle | null;
  setServices: (services: PluginServicesHandle | null) => void;
}) {
  let current: GatewayPluginRuntimeClaim;
  let latestReservation: GatewayPluginRuntimeClaim | undefined;
  let reloadStatus: GatewayPluginReloadStatus | undefined;
  let pending:
    | {
        claim: GatewayPluginRuntimeClaim;
        settled: ReturnType<typeof createDeferredCore<void>>;
      }
    | undefined;

  const createClaim = (): GatewayPluginRuntimeClaim => {
    const claim: GatewayPluginRuntimeClaim = Object.freeze({
      isCurrent: () => current === claim && pending === undefined,
      waitForUnblocked: async () => {
        for (;;) {
          const reservation = pending;
          if (current !== claim || !reservation) {
            return claim.isCurrent();
          }
          await reservation.settled.promise;
        }
      },
      publish: (publication: () => void) => {
        if (!claim.isCurrent()) {
          return false;
        }
        publication();
        return true;
      },
    });
    return claim;
  };
  current = createClaim();

  return {
    getReloadStatus: () => reloadStatus,
    currentClaim: () => current,
    currentServices: () => params.getServices(),
    publishServices: (claim: GatewayPluginRuntimeClaim, services: PluginServicesHandle | null) =>
      claim.publish(() => params.setServices(services)),
    reserve: (): GatewayPluginRuntimeReservation => {
      if (pending) {
        throw new Error("a Gateway plugin runtime replacement is already pending");
      }
      const reservation = { claim: createClaim(), settled: createDeferredCore() };
      const previousReloadStatus = reloadStatus;
      latestReservation = reservation.claim;
      pending = reservation;
      const settle = (accepted: boolean) => {
        if (pending !== reservation) {
          return;
        }
        if (accepted) {
          current = reservation.claim;
        }
        pending = undefined;
        reservation.settled.resolve();
      };
      return Object.freeze({
        claim: reservation.claim,
        commit: () => settle(true),
        reject: () => settle(false),
        setReloadStatus: (status) => {
          if (latestReservation === reservation.claim) {
            reloadStatus = status;
          }
        },
        finishReload: (outcome, pluginIds, registry, reportFailure) => {
          if (latestReservation !== reservation.claim) {
            return;
          }
          if (outcome === "unchanged") {
            reloadStatus = previousReloadStatus;
            return;
          }
          // Recovery can omit previously retired owners whose captured code is gone.
          const restoredIds =
            outcome === "restored"
              ? new Set(
                  registry.plugins
                    .filter(
                      (record) =>
                        record.status === "loaded" &&
                        (record.format === "bundle" || getPluginInstance(record)?.acceptingCalls),
                    )
                    .map((record) => record.id),
                )
              : pluginIds;
          const failedIds = new Set(
            previousReloadStatus?.phase === "failed"
              ? previousReloadStatus.pluginIds.filter(
                  (id) => !pluginIds.has(id) || !restoredIds.has(id),
                )
              : [],
          );
          if (outcome === "failed") {
            for (const id of pluginIds) {
              failedIds.add(id);
            }
          }
          reloadStatus = failedIds.size
            ? {
                phase: "failed",
                pluginIds: [...failedIds].toSorted(),
                reason:
                  "Plugin activation or recovery failed. Retry openclaw plugins reload <id> after admitted work settles, or restart the Gateway. Inspect the Gateway log for the failure.",
              }
            : undefined;
          if (outcome === "failed" && reloadStatus?.reason) {
            reportFailure?.(reloadStatus.reason);
          }
        },
      });
    },
  };
}
