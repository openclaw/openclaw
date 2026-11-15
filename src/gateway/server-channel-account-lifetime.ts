import { resolveChannelAccount } from "../channels/account-resolution.js";
import type { ChannelGatewayContextV2 } from "../channels/plugins/types.adapters.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot, ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "../plugins/capability-lease.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import { getPluginValueInstance, runPluginCleanup } from "../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginServiceScheduler } from "../plugins/service-scheduler-binding.js";
import { createPluginServiceSchedulerRunner } from "../plugins/service-scheduler-context.js";
import { createPluginServiceScheduler } from "../plugins/service-scheduler.js";
import type { PluginServiceSchedulerV1 } from "../plugins/service-scheduler.types.js";
import type {
  ChannelAccountLifecycle,
  ChannelAccountLifetime,
  ChannelAccountStopOutcome,
  StartChannelOptions,
} from "./server-channel-runtime.types.js";

export function captureChannelAccountRestart(params: {
  store:
    | {
        lifetimes: ReadonlyMap<string, ChannelAccountLifetime>;
        runtimes: ReadonlyMap<string, ChannelAccountSnapshot>;
      }
    | undefined;
  channelId: ChannelId;
  accountId: string;
  reason: StartChannelOptions["reason"];
  resetRestartAttempts?: boolean;
  manager: Pick<
    ChannelAccountLifecycle,
    | "stopChannel"
    | "startChannel"
    | "isAccountListed"
    | "isManuallyStopped"
    | "resetRestartAttempts"
  >;
  log: SubsystemLogger;
}): ReturnType<ChannelAccountLifecycle["captureAccountRestart"]> {
  const { store, channelId, accountId, reason, manager, log } = params;
  let expectedLifetime = store?.lifetimes.get(accountId);
  if (!store || !expectedLifetime) {
    return undefined;
  }
  let stopRequested = false;
  return async (shouldContinue) => {
    const lifetimeBeforeStop = store.lifetimes.get(accountId);
    if (
      (lifetimeBeforeStop !== expectedLifetime && (lifetimeBeforeStop || !stopRequested)) ||
      manager.isManuallyStopped(channelId, accountId) ||
      !manager.isAccountListed(channelId, accountId)
    ) {
      return true;
    }
    if (!shouldContinue()) {
      return false;
    }
    // Stop installs its gate synchronously. A deferred recovery may only stop
    // its captured lifetime, never a replacement installed by another owner.
    if (lifetimeBeforeStop) {
      stopRequested = true;
      await manager.stopChannel(channelId, accountId, { manual: false });
    }
    const currentLifetime = store.lifetimes.get(accountId);
    if (currentLifetime && currentLifetime !== expectedLifetime) {
      return true;
    }
    // Our stop may remove the lifetime now or after timed-out work finally exits.
    // Either absence remains ours to retry; only a replacement ends ownership.
    expectedLifetime = currentLifetime;
    if (!shouldContinue()) {
      return false;
    }
    if (
      manager.isManuallyStopped(channelId, accountId) ||
      !manager.isAccountListed(channelId, accountId)
    ) {
      return true;
    }
    if (params.resetRestartAttempts) {
      // Health recovery resets before fallible preparation, but never for a
      // replacement or an account whose recovery authority was withdrawn.
      manager.resetRestartAttempts(channelId, accountId);
    }
    const outcomes = await manager.startChannel(channelId, accountId, {
      reason,
      preserveManualStop: true,
    });
    const outcome = outcomes.get(accountId);
    if (outcome?.status === "retry") {
      const lastError = store.runtimes.get(accountId)?.lastError;
      log.warn?.(
        `[${accountId}] ${reason} restart failed: replacement was not handed off (${outcome.reason})${lastError ? `: ${lastError}` : ""}`,
      );
      return false;
    }
    return true;
  };
}

export function createChannelAccountLifetime(
  plugin: ChannelPlugin,
  registry: PluginRegistry,
  rootScheduler: GatewayScheduler,
): ChannelAccountLifetime {
  const abort = new AbortController();
  const capabilityLease = createPluginRuntimeCapabilityLease("channel account");
  const instance = getPluginValueInstance(plugin);
  const { scheduler } = createPluginServiceScheduler(
    rootScheduler,
    createPluginServiceSchedulerRunner({
      registry,
      record: instance?.owner?.record,
      instance,
      lease: capabilityLease,
    }),
  );
  abort.signal.addEventListener("abort", scheduler.beginClose, { once: true });
  return { plugin, abort, capabilityLease, scheduler };
}

export async function runChannelAccountStop(params: {
  registry: PluginRegistry;
  rootScheduler: GatewayScheduler;
  lease: PluginRuntimeCapabilityLease;
  teardown: ChannelAccountLifetime["teardown"];
  fallback?: {
    plugin: ChannelPlugin;
    gateway: NonNullable<ChannelPlugin["gateway"]>;
    stopAccount: NonNullable<NonNullable<ChannelPlugin["gateway"]>["stopAccount"]>;
    cfg: OpenClawConfig;
    accountId: string;
  };
  createFallbackContext: (
    account: unknown,
    scheduler: PluginServiceSchedulerV1,
  ) => Omit<ChannelGatewayContextV2, "setStatus">;
  setStatus: ChannelGatewayContextV2["setStatus"];
  onCleanupStarted: () => void;
  onError: (error: unknown) => void;
}): Promise<ChannelAccountStopOutcome> {
  try {
    await withPluginHttpRouteRegistry(
      params.registry,
      async () => {
        let teardown = params.teardown;
        if (params.fallback) {
          const { plugin, gateway, stopAccount, cfg, accountId } = params.fallback;
          const account = await runPluginCleanup(plugin, () =>
            resolveChannelAccount({ plugin, cfg, accountId }),
          );
          params.lease.assertActive("account resolution");
          const { scheduler } = createPluginServiceScheduler(params.rootScheduler);
          await scheduler.stop();
          teardown = {
            context: params.createFallbackContext(account, scheduler),
            run: (context) =>
              runPluginCleanup(stopAccount, () => stopAccount.call(gateway, context)),
          };
        }
        if (!teardown) {
          return;
        }
        const { context, run } = teardown;
        // The owner cancels transport and flushes admitted delivery before its work can join.
        const cleanup = Promise.resolve().then(() => {
          params.lease.assertActive("account cleanup");
          params.onCleanupStarted();
          return withPluginServiceScheduler(context.scheduler, () =>
            run({ ...context, setStatus: params.setStatus }),
          );
        });
        const scheduled = context.scheduler.stop();
        try {
          await cleanup;
        } finally {
          await scheduled;
        }
      },
      params.lease,
    );
    return { status: "fulfilled" };
  } catch (error) {
    params.onError(error);
    return { status: "rejected", error };
  }
}
