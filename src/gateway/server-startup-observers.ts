import { setImmediate as nextTurn } from "node:timers/promises";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import type { createHookRunner } from "../plugins/hooks.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { sweepSessionStateWatchNotices } from "../sessions/session-state-events.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

// Startup only needs orphan marking; keep resume and delivery runtime out of the pre-channel path.
const loadMainSessionRestartRecoveryMarkingModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery-marking.js"),
);

/** Mark predecessors before channels admit work, independently of plugin registration. */
export async function markGatewayStartupMainSessionOrphans(
  params: {
    gatewayPluginConfigAtStart: OpenClawConfig;
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
      if (params.scheduler.signal.aborted || params.isRestartRecoverySuppressed()) {
        return;
      }
      await measureStartup(params.startupTrace, "sidecars.main-session-recovery-scan", () =>
        markStartupOrphanedMainSessionsForRecovery({
          cfg: params.gatewayPluginConfigAtStart,
          startupCheckedStorePaths,
        }),
      );
    } catch (err) {
      params.log.warn(
        `main-session startup orphan marking failed before channel startup: ${String(err)}`,
      );
    }
  });
}

type SubagentRegistryActivation = (
  resolveGatewayContext: GatewayContextResolver,
) => void | Promise<void>;

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
  waitForPostReadyWork?: () => Promise<void>;
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
  await params.waitForPostReadyWork?.();
  if (params.signal.aborted || params.isClosing?.()) {
    return;
  }
  try {
    await runWithGatewayIndependentRootWorkAdmission(
      async () => {
        await measureStartup(params.startupTrace, "sidecars.subagent-recovery", async () => {
          // Restored wakes start their admission budget at dispatch. Join reader startup
          // first, including maintenance that shares compute with foreground admission.
          const { prewarmGatewaySessionHistory } = await import("./server-history-prewarm.js");
          await prewarmGatewaySessionHistory(params.config, {
            includeMaintenance: true,
            isCancelled: () => params.signal.aborted || params.isClosing?.() === true,
          });
          const activateSubagentRegistry = await params.loadSubagentRegistryActivation();
          if (!params.signal.aborted && params.isClosing?.() !== true) {
            await activateSubagentRegistry(params.resolveGatewayContext);
          }
        });
      },
      "startup:subagent-recovery",
      params.signal,
    );
  } catch (err) {
    if (!params.signal.aborted && !params.isClosing?.()) {
      params.log.warn(`subagent restart recovery failed to activate: ${String(err)}`);
    }
  }
  if (params.signal.aborted || params.isClosing?.()) {
    return;
  }
  await nextTurn();
  if (params.signal.aborted || params.isClosing?.()) {
    return;
  }
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
    // Refresh and hooks run concurrently; failed hook loading still owns the refresh.
    await sentinelRefresh;
  }
}
