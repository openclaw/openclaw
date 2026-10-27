import { setImmediate as nextTurn } from "node:timers/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { formatErrorMessageWithCode } from "../infra/errors.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import type { createHookRunner } from "../plugins/hooks.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { sweepSessionStateWatchNotices } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { AgentRecoveryProgress } from "../state/agent-database-preparation-recovery.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

// Keep orphan marking independent of the resume and delivery runtime.
const loadMainSessionRestartRecoveryMarkingModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery-marking.js"),
);

/** Mark predecessors before channels and saved inputs admit work. */
export async function markGatewayStartupMainSessionOrphans(
  params: {
    getConfig: () => OpenClawConfig;
    isRestartRecoverySuppressed: () => boolean;
    scheduler: { signal: AbortSignal };
    startupTrace?: GatewayStartupTrace;
    log: { warn: (message: string) => void };
  },
  startupCheckedStorePaths: Set<string>,
): Promise<void> {
  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    try {
      if (params.scheduler.signal.aborted || params.isRestartRecoverySuppressed()) {
        return;
      }
      const { markStartupOrphanedMainSessionsForRecovery } = await measureStartup(
        params.startupTrace,
        "sidecars.main-session-recovery-load",
        loadMainSessionRestartRecoveryMarkingModule,
      );
      while (!params.scheduler.signal.aborted && !params.isRestartRecoverySuppressed()) {
        const cfg = params.getConfig();
        try {
          await measureStartup(params.startupTrace, "sidecars.main-session-recovery-scan", () =>
            markStartupOrphanedMainSessionsForRecovery({
              cfg,
              startupCheckedStorePaths,
              assertCommitAllowed: () => {
                params.scheduler.signal.throwIfAborted();
                if (params.isRestartRecoverySuppressed() || params.getConfig() !== cfg) {
                  throw new Error("Gateway restart recovery state changed before orphan marking");
                }
              },
            }),
          );
        } catch (err) {
          if (params.getConfig() === cfg) {
            throw err;
          }
        }
        // A store can return a failed target instead of throwing after invalidation.
        // Keep admission held; the checked set skips stores that already committed.
        if (params.getConfig() === cfg) {
          return;
        }
      }
    } catch (err) {
      params.log.warn(`main-session startup orphan marking failed: ${String(err)}`);
    }
  });
}

type SubagentRegistryActivation = (
  resolveGatewayContext: GatewayContextResolver,
  startupTrace?: GatewayStartupTrace,
) => AgentRecoveryProgress;

/** The tracked post-ready tail owns recovery and observers until their original work settles. */
export async function runGatewayStartupObservers(params: {
  registry: PluginRegistry;
  resolveGatewayContext: GatewayContextResolver;
  loadSubagentRegistryActivation: () =>
    | SubagentRegistryActivation
    | Promise<SubagentRegistryActivation>;
  signal: AbortSignal;
  port: number;
  config: OpenClawConfig;
  workspaceDir: string;
  getCron: () => PluginHookGatewayCronService | undefined;
  isClosing?: () => boolean;
  onSubagentRecoverySettled?: () => void;
  unlockStartupMethods?: () => void;
  trackInputRecovery?: (progress: Promise<AgentRecoveryProgress>) => Promise<void>;
  startupTrace?: GatewayStartupTrace;
  log: { warn: (message: string) => void };
  logHooks: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  createHookRunner: (
    ...args: Parameters<typeof createHookRunner>
  ) => ReturnType<typeof createHookRunner> | Promise<ReturnType<typeof createHookRunner>>;
  refreshLatestUpdateRestartSentinel: () => Promise<unknown>;
}): Promise<void> {
  if (params.signal.aborted || params.isClosing?.()) {
    return;
  }
  await nextTurn();
  if (params.signal.aborted || params.isClosing?.()) {
    return;
  }
  const deletionRecovery = runWithGatewayIndependentRootWorkAdmission(
    async () => {
      const context = params.resolveGatewayContext();
      if (context && !params.signal.aborted && !params.isClosing?.()) {
        const { resumeAgentDeletions } = await import("./server-agent-deletion-recovery.js");
        await resumeAgentDeletions(context, params.signal);
      }
    },
    "startup:agent-deletion-recovery",
    params.signal,
  ).catch((error: unknown) => {
    if (!params.signal.aborted && !params.isClosing?.()) {
      params.log.warn(`Agent deletion recovery failed before replay: ${String(error)}`);
    }
    throw error;
  });
  const deliveryProgress = createDeferredCore<AgentRecoveryProgress>();
  const execProgress = createDeferredCore<AgentRecoveryProgress>();
  const registryProgress = createDeferredCore<AgentRecoveryProgress>();
  const completed = Promise.resolve();
  const noRecovery: AgentRecoveryProgress = {
    initial: completed,
    pending: new Map(),
    settled: completed,
  };
  // Publish admission progress without releasing the root work that owns each full tail.
  const initialRecovery = Promise.allSettled(
    [deliveryProgress, execProgress, registryProgress].map(({ promise }) =>
      params.trackInputRecovery
        ? params.trackInputRecovery(promise)
        : promise.then((progress) => progress.initial),
    ),
  ).then((outcomes) => {
    if (
      outcomes.every((outcome) => outcome.status === "fulfilled") &&
      !params.signal.aborted &&
      params.isClosing?.() !== true
    ) {
      params.unlockStartupMethods?.();
    }
  });
  // Delivery keeps its admission and shutdown tail outside registry activation.
  const delivery = runWithGatewayIndependentRootWorkAdmission(
    async () => {
      await deletionRecovery;
      const context = params.resolveGatewayContext();
      if (context && !params.signal.aborted && !params.isClosing?.()) {
        await measureStartup(params.startupTrace, "sidecars.delivery-recovery", async () => {
          const { recoverSessionSendDeliveries } = await import("./session-send-recovery.js");
          const progress = recoverSessionSendDeliveries(
            context,
            params.signal,
            params.startupTrace,
          );
          deliveryProgress.resolve(progress);
          await progress.settled;
        });
      }
    },
    "startup:delivery-recovery",
    params.signal,
  )
    .catch((error: unknown) => {
      deliveryProgress.reject(error);
      if (!params.signal.aborted) {
        params.log.warn(
          `Session delivery restart recovery could not complete; saved inputs remain available: ${formatErrorMessageForDisplay(error, formatErrorMessageWithCode(error))}`,
        );
      }
    })
    .finally(() => deliveryProgress.resolve(noRecovery));
  const recovery = runWithGatewayIndependentRootWorkAdmission(
    async () => {
      await deletionRecovery;
      await measureStartup(params.startupTrace, "sidecars.subagent-recovery", async () => {
        // Each recovery owner retains its pending agents. Their waits must not
        // serialize unrelated recovery, and shutdown still joins every tail.
        const outcomes = await Promise.allSettled([
          (async () => {
            if (!params.signal.aborted && !params.isClosing?.()) {
              await measureStartup(params.startupTrace, "sidecars.exec-recovery", async () => {
                try {
                  const { recoverExecExitNotifications } =
                    await import("../agents/bash-tools.exec-notify.js");
                  await withPluginRuntimeGatewayContextResolver(
                    params.resolveGatewayContext,
                    async () => {
                      const progress = recoverExecExitNotifications(params.config, params.signal);
                      execProgress.resolve(progress);
                      await progress.settled;
                    },
                    { inheritRequestScope: false },
                  );
                } catch (error) {
                  execProgress.reject(error);
                  if (!params.signal.aborted) {
                    params.log.warn(`Exec restart notifications remain pending: ${String(error)}`);
                  }
                }
              });
            }
          })().finally(() => execProgress.resolve(noRecovery)),
          (async () => {
            const activateSubagentRegistry = await measureStartup(
              params.startupTrace,
              "sidecars.subagent-load",
              params.loadSubagentRegistryActivation,
            );
            if (!params.signal.aborted && params.isClosing?.() !== true) {
              await measureStartup(
                params.startupTrace,
                "sidecars.subagent-activation",
                async () => {
                  const progress = activateSubagentRegistry(
                    params.resolveGatewayContext,
                    params.startupTrace,
                  );
                  registryProgress.resolve(progress);
                  await progress.settled;
                },
              );
            }
          })()
            .catch((error: unknown) => {
              registryProgress.reject(error);
              throw error;
            })
            .finally(() => registryProgress.resolve(noRecovery)),
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            throw outcome.reason;
          }
        }
      });
    },
    "startup:subagent-recovery",
    params.signal,
  )
    .catch((err: unknown) => {
      execProgress.reject(err);
      registryProgress.reject(err);
      if (!params.signal.aborted && !params.isClosing?.()) {
        params.log.warn(`subagent restart recovery failed to activate: ${String(err)}`);
      }
    })
    .finally(() => {
      execProgress.resolve(noRecovery);
      registryProgress.resolve(noRecovery);
    });
  // Suspended admission can retire replay before it awaits deletion recovery.
  const inputRecovery = Promise.allSettled([deletionRecovery, recovery, delivery]).finally(() => {
    // The main-session sweep must not reserve predecessors during saved-input admission.
    params.onSubagentRecoverySettled?.();
  });
  const sentinelRefresh = runWithGatewayIndependentRootWorkAdmission(
    async () => {
      await measureStartup(params.startupTrace, "post-attach.update-sentinel", async () => {
        if (!params.isClosing?.()) {
          await params.refreshLatestUpdateRestartSentinel();
        }
      });
    },
    "startup:update-sentinel",
    params.signal,
  ).catch((err: unknown) => {
    params.log.warn(`restart sentinel refresh failed: ${String(err)}`);
  });
  try {
    await sweepSessionStateWatchNotices();
    const hookRunner = await params.createHookRunner(params.registry, { logger: params.logHooks });
    if (params.isClosing?.() || !hookRunner.hasHooks("gateway_start")) {
      return;
    }
    const { withPluginHttpRouteRegistry } = await import("../plugins/http-registry.js");
    if (params.isClosing?.()) {
      return;
    }
    await runWithGatewayIndependentRootWorkAdmission(
      async () => {
        if (params.isClosing?.()) {
          return;
        }
        await withPluginHttpRouteRegistry(params.registry, () =>
          hookRunner.runGatewayStart(
            { port: params.port },
            {
              port: params.port,
              config: params.config,
              workspaceDir: params.workspaceDir,
              abortSignal: AbortSignal.any([params.signal, getGatewayRestartDrainSignal()]),
              getCron: params.getCron,
            },
          ),
        );
      },
      "hooks:gateway-start",
      params.signal,
    ).catch((err: unknown) => {
      params.log.warn(`gateway_start hook failed: ${String(err)}`);
    });
  } finally {
    // Independent observers overlap, but shutdown joins all accepted startup work.
    await Promise.all([sentinelRefresh, initialRecovery, inputRecovery]);
  }
}
