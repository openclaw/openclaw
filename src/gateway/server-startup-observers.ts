import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-gateway.types.js";
import type { createHookRunner } from "../plugins/hooks.js";
import type { PluginRegistry } from "../plugins/registry.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { sweepSessionStateWatchNotices } from "../sessions/session-state-events.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";

/** The tracked startup tail owns both observers until their original work settles. */
export async function runGatewayStartupObservers(params: {
  registry: PluginRegistry;
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
  if (params.isClosing?.()) {
    return;
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  if (params.isClosing?.()) {
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
    sweepSessionStateWatchNotices();
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
