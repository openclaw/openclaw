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
import type { GatewayContextResolver } from "./server-methods/types.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

type SubagentRegistryActivation = (resolveGatewayContext: GatewayContextResolver) => Promise<void>;

/** Resume explicit graceful-shutdown markers through ordinary input admission. */
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
  unlockStartupMethods?: () => void;
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
  await runWithGatewayIndependentRootWorkAdmission(
    async () => {
      const context = params.resolveGatewayContext();
      if (!context || params.signal.aborted || params.isClosing?.()) {
        return;
      }
      const { resumeAgentDeletions } = await import("./server-agent-deletion-recovery.js");
      await resumeAgentDeletions(context, params.signal);
      const activateSubagentRegistry = await params.loadSubagentRegistryActivation();
      if (params.signal.aborted || params.isClosing?.()) {
        return;
      }
      await activateSubagentRegistry(params.resolveGatewayContext);
      if (params.signal.aborted || params.isClosing?.()) {
        return;
      }
      params.unlockStartupMethods?.();
      const { resumeMarkedSessions } = await import("./session-restart-resume.js");
      await resumeMarkedSessions({ context, signal: params.signal, log: params.log });
    },
    "startup:session-resume",
    params.signal,
  );
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
    // Independent observers overlap, but shutdown joins all accepted startup work.
    await sentinelRefresh;
  }
}
