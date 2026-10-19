import { isRestartEnabled } from "../config/commands.flags.js";
import { setRuntimeConfigAppliedHash } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayRestartDeferralTimeoutMs } from "../infra/restart-budget.js";
import {
  deferGatewayRestartUntilIdle,
  type RestartDeferralHandle,
  setGatewayRestartPolicy,
} from "../infra/restart.js";
import { createAppliedConfigHashPublisher } from "./applied-config-hash-publisher.js";
import type { GatewayReloadPlan } from "./config-reload.js";
import type { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import type {
  GatewayReloadHandlerParams,
  GatewayRestartRequestOptions,
  GatewayRestartTransactionResult,
  GatewayRestartTransactionState,
} from "./server-reload-contracts.js";

type GatewayRestartOperation = {
  kind: "lifecycle" | "request";
  state: GatewayRestartTransactionState;
};

type GatewayRestartCoordinatorParams = Pick<
  GatewayReloadHandlerParams,
  "scheduler" | "assertRestartReady" | "logReload" | "requestRecoveryRestart"
>;

type GatewayRestartCoordinatorOptions = {
  params: GatewayRestartCoordinatorParams;
  reloadSignal: AbortSignal;
  restartRecoveryAvailable: boolean;
  hasAcceptedRestart?: () => boolean;
} & Pick<
  ReturnType<typeof createGatewayActiveWorkTracker>,
  "getActiveCounts" | "formatActiveDetails" | "formatDeferredWorkStatus"
>;

class GatewayRestartTransaction {
  private stopped = false;
  private restartDeferral: RestartDeferralHandle | null = null;
  private operation: GatewayRestartOperation | undefined;

  readonly appliedConfigHashPublisher = createAppliedConfigHashPublisher({
    hasPendingRestart: () =>
      !this.stopped &&
      (this.operation?.kind === "request" || this.options.hasAcceptedRestart?.() === true),
    publish: setRuntimeConfigAppliedHash,
  });

  constructor(private readonly options: GatewayRestartCoordinatorOptions) {}

  readonly isStopped = () => this.stopped;
  acceptConfig() {
    if (this.operation?.state !== "rejected") {
      return { retireRejectedRestart: false };
    }
    this.supersedeRequest();
    return { retireRejectedRestart: true };
  }

  beginLifecycle() {
    this.supersedeRequest();
    const transaction: GatewayRestartOperation = { kind: "lifecycle", state: "pending" };
    this.operation = transaction;
    return {
      settle: (state: Exclude<GatewayRestartTransactionState, "pending">) => {
        transaction.state = state;
      },
    };
  }

  pauseForConfigCandidate(): void {
    this.beginLifecycle().settle("rejected");
  }

  request(
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    options?: GatewayRestartRequestOptions,
  ): GatewayRestartTransactionResult {
    if (this.isStopped()) {
      return { status: "recovery-pending", settle: () => {} };
    }
    this.supersedeRequest();
    const transaction: GatewayRestartOperation = { kind: "request", state: "pending" };
    this.operation = transaction;
    const accepted = this.requestForOperation(plan, nextConfig, transaction, options);
    return {
      status: accepted ? "accepted" : "recovery-pending",
      settle: (state) => {
        if (transaction.state === "pending") {
          transaction.state = state;
        }
      },
    };
  }

  stop(): void {
    this.stopped = true;
    this.supersedeRequest();
  }

  private isCurrentRequest(operation: GatewayRestartOperation): boolean {
    return (
      !this.isStopped() &&
      !this.options.params.scheduler.signal.aborted &&
      operation === this.operation &&
      !this.options.reloadSignal.aborted
    );
  }

  private supersedeRequest(): void {
    this.restartDeferral?.cancel();
    this.restartDeferral = null;
    this.operation = undefined;
  }

  private requestForOperation(
    plan: GatewayReloadPlan,
    nextConfig: OpenClawConfig,
    operation: GatewayRestartOperation,
    options?: GatewayRestartRequestOptions,
  ): boolean {
    const { params } = this.options;
    const reasons = plan.restartReasons.length
      ? plan.restartReasons.join(", ")
      : plan.changedPaths.join(", ");
    const restartReason = `config reload: ${reasons}`;

    if (!this.options.restartRecoveryAvailable) {
      params.logReload.warn(
        "gateway restart recovery unavailable; restart-required reload rejected",
      );
      return false;
    }
    if (!params.requestRecoveryRestart) {
      params.logReload.warn("gateway restart recovery handler unavailable; restart skipped");
      return false;
    }
    const requestRecoveryRestart = params.requestRecoveryRestart;
    let emissionPrepared = true;
    let preparing = false;
    const prepareForEmit = async () => {
      try {
        await params.assertRestartReady?.(nextConfig);
        const preparedConfig = options?.prepareRuntimeConfig
          ? await options.prepareRuntimeConfig()
          : nextConfig;
        if (!this.isCurrentRequest(operation)) {
          return false;
        }
        emissionPrepared = true;
        setGatewayRestartPolicy({ allowExternal: isRestartEnabled(preparedConfig) });
        return true;
      } catch (err) {
        emissionPrepared = false;
        params.logReload.warn(`gateway restart preflight failed: ${String(err)}`);
        return false;
      }
    };

    const active = this.options.getActiveCounts();

    if (active.totalActive > 0 || options?.prepareRuntimeConfig || params.assertRestartReady) {
      if (active.totalActive > 0) {
        const initialDetails = this.options.formatActiveDetails(active);
        params.logReload.warn(
          `config change requires gateway restart (${reasons}) — deferring until ${initialDetails.join(", ")} complete`,
        );
      } else {
        params.logReload.warn(`config change requires gateway restart (${reasons}) — preparing`);
      }

      // Timeout and failed checks leave a live deferral owned by this request.
      this.restartDeferral = deferGatewayRestartUntilIdle({
        getPendingCount: () => this.options.getActiveCounts().totalActive,
        maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(undefined),
        timeoutIntent: { force: true, reason: "config reload forced restart" },
        reason: restartReason,
        // Preparation can wait for the plugin lifecycle lease, whose holders need
        // root admission; the deferral runs it before taking the signal fence.
        prepareEmission: async () => {
          preparing = true;
          try {
            emissionPrepared = await prepareForEmit();
          } finally {
            preparing = false;
          }
        },
        emitHooks: {
          emitRestart: (reason, intent) => {
            if (!this.isCurrentRequest(operation)) {
              return { status: "coalesced" };
            }
            const resolvedReason = reason ?? restartReason;
            if (!emissionPrepared) {
              operation.state = "rejected";
              params.logReload.warn(
                "gateway restart preparation failed; reapply the config or restart the Gateway manually",
              );
              return { status: "failed" };
            }
            const emitResult = requestRecoveryRestart(resolvedReason, intent);
            if (emitResult.status === "failed") {
              operation.state = "rejected";
              params.logReload.warn(
                "gateway restart recovery emission failed; reapply the config or restart the Gateway manually",
              );
            } else {
              params.logReload.info("all operations and replies completed; restarting gateway now");
            }
            return emitResult;
          },
        },
        hooks: {
          onReady: () => {
            this.restartDeferral = null;
          },
          onStillPending: (_pending, elapsedMs) => {
            params.logReload.warn(
              `restart still deferred after ${elapsedMs}ms with ${preparing ? "restart preparation pending; " : ""}${this.options.formatDeferredWorkStatus("active")}`,
            );
          },
          onTimeout: (_pending, elapsedMs) => {
            // Keep the handle until preparation settles or the request is cancelled.
            params.logReload.warn(
              `restart timeout after ${elapsedMs}ms with ${this.options.formatDeferredWorkStatus("still active")}; forcing restart`,
            );
          },
          onCheckError: (err) => {
            params.logReload.warn(
              `restart deferral check failed (${String(err)}); pending work is unknown, deferring and retrying`,
            );
          },
        },
      });
      setGatewayRestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
      return true;
    }
    params.logReload.warn(`config change requires gateway restart (${reasons})`);
    // The managed reloader owns independent root admission until onRestart
    // returns. Extend that fence across signal delivery until the run loop
    // atomically promotes it to one-way restart drain.
    const emitResult = requestRecoveryRestart(restartReason);
    if (emitResult.status === "failed") {
      params.logReload.warn(
        "gateway restart recovery emission failed; reapply the config or restart the Gateway manually",
      );
      return false;
    }
    if (emitResult.status === "coalesced") {
      params.logReload.info("gateway restart already scheduled; skipping duplicate signal");
    }
    setGatewayRestartPolicy({ allowExternal: isRestartEnabled(nextConfig) });
    return true;
  }
}

export function createGatewayRestartCoordinator(options: GatewayRestartCoordinatorOptions) {
  const transaction = new GatewayRestartTransaction(options);
  return {
    acceptRestartConfig: transaction.acceptConfig.bind(transaction),
    ...transaction.appliedConfigHashPublisher,
    beginGatewayRestartLifecycle: transaction.beginLifecycle.bind(transaction),
    pauseGatewayRestartForConfigCandidate: transaction.pauseForConfigCandidate.bind(transaction),
    requestGatewayRestart: transaction.request.bind(transaction),
    stopRestartRetries: transaction.stop.bind(transaction),
    isRestartRetryStopped: transaction.isStopped,
  };
}
