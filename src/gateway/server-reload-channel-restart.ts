import { resolveChannelAccount } from "../channels/account-resolution.js";
import { getLoadedChannelPluginEntryById } from "../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ChannelKind } from "./config-reload-plan.js";
import type { createGatewayActiveWorkTracker } from "./server-reload-active-work.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";

export async function waitForGatewayChannelReload(options: {
  params: Pick<GatewayReloadHandlerParams, "getPluginRegistry" | "logChannels">;
  nextConfig: OpenClawConfig;
  channelsToRestart: ReadonlySet<ChannelKind>;
  restartChannelAccounts: ReadonlyMap<ChannelKind, Set<string>>;
  shouldSkipChannelRestart: boolean;
  waitForActiveWorkBeforeChannelReload: ReturnType<
    typeof createGatewayActiveWorkTracker
  >["waitForActiveWorkBeforeChannelReload"];
  isCurrent: () => boolean;
  publicationPending: boolean;
}): Promise<boolean> {
  const { params, nextConfig, channelsToRestart, restartChannelAccounts } = options;
  if (options.shouldSkipChannelRestart) {
    return false;
  }
  const targets = new Set([...channelsToRestart, ...restartChannelAccounts.keys()]);
  for (const [channel, accountIds] of restartChannelAccounts) {
    if (channelsToRestart.has(channel)) {
      continue;
    }
    const plugin = getLoadedChannelPluginEntryById(channel, params.getPluginRegistry())?.plugin;
    try {
      const configuredIds = plugin?.config.listAccountIds(nextConfig);
      if (configuredIds && ![...accountIds].some((id) => configuredIds.includes(id))) {
        targets.delete(channel);
      }
    } catch (error) {
      params.logChannels.info(
        `retaining ${channel} reload drain after account enumeration failed: ${formatErrorMessage(error)}`,
      );
    }
  }
  return targets.size > 0
    ? await options.waitForActiveWorkBeforeChannelReload(
        targets,
        options.isCurrent,
        options.publicationPending,
      )
    : false;
}

export async function restartGatewayChannels(options: {
  params: Pick<
    GatewayReloadHandlerParams,
    | "startChannel"
    | "stopChannel"
    | "logChannels"
    | "getPluginRegistry"
    | "releaseChannelRouteHandoffs"
  >;
  nextConfig: OpenClawConfig;
  channelsToRestart: Set<ChannelKind>;
  restartChannelAccounts: ReadonlyMap<ChannelKind, Set<string>>;
  activePluginChannelsAfterReload: ReadonlySet<ChannelKind> | null;
  shouldSkipChannelRestart: boolean;
  isLifecycleReloadAborted: () => boolean;
  getChannelAutostartSuppression: () => unknown;
  scheduleRecoveryRestart: (surface: string, err?: unknown) => void;
}): Promise<void> {
  const {
    params,
    nextConfig,
    channelsToRestart,
    restartChannelAccounts,
    activePluginChannelsAfterReload,
    shouldSkipChannelRestart,
    isLifecycleReloadAborted,
    getChannelAutostartSuppression,
    scheduleRecoveryRestart,
  } = options;
  type AccountTarget = { channel: ChannelKind; accountId: string; removed: boolean };
  const collectChannelAccountTargets = async (): Promise<AccountTarget[]> => {
    const targets: AccountTarget[] = [];
    for (const [channel, accountIds] of restartChannelAccounts) {
      if (
        channelsToRestart.has(channel) ||
        activePluginChannelsAfterReload?.has(channel) === false
      ) {
        continue;
      }
      const plugin = getLoadedChannelPluginEntryById(channel, params.getPluginRegistry())?.plugin;
      let listedAccountIds: Set<string>;
      try {
        listedAccountIds = new Set(plugin?.config.listAccountIds(nextConfig) ?? []);
      } catch (err) {
        scheduleRecoveryRestart(`channel account enumeration (${channel})`, err);
        continue;
      }
      try {
        for (const accountId of accountIds) {
          if (plugin && listedAccountIds.has(accountId)) {
            await resolveChannelAccount({ plugin, cfg: nextConfig, accountId });
          }
        }
      } catch (err) {
        params.logChannels.info(
          `promoting ${channel} account reload to whole-channel restart after account resolution failed: ${formatErrorMessage(err)}`,
        );
        channelsToRestart.add(channel);
        continue;
      }
      for (const accountId of accountIds) {
        targets.push({ channel, accountId, removed: !listedAccountIds.has(accountId) });
      }
    }
    return targets;
  };

  if (channelsToRestart.size === 0 && restartChannelAccounts.size === 0) {
    return;
  }
  if (shouldSkipChannelRestart) {
    params.logChannels.info(
      "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
    );
    return;
  }
  const accountTargets = await collectChannelAccountTargets();
  if (isLifecycleReloadAborted()) {
    return;
  }
  const suppressed = Boolean(getChannelAutostartSuppression());
  const operation = suppressed ? "stop" : "restart";
  const phase = suppressed ? "suppressed hot reload" : "hot reload";
  const targets = [
    ...accountTargets,
    ...[...channelsToRestart].map((channel) => ({ channel, accountId: undefined, removed: false })),
  ];
  const failures: string[] = [];
  for (const { channel, accountId, removed } of targets) {
    if (activePluginChannelsAfterReload?.has(channel) === false) {
      continue;
    }
    const target =
      accountId === undefined ? `${channel} channel` : `${channel} account ${accountId}`;
    try {
      params.logChannels.info(
        removed
          ? `stopping ${target} after account removal`
          : suppressed
            ? `stopping ${target} before suppressed hot reload`
            : `restarting ${target}`,
      );
      const canRestart = () => !removed && !suppressed && !isLifecycleReloadAborted();
      await params.stopChannel(channel, accountId, {
        manual: false,
        ...(removed ? { strict: true } : {}),
        ...(canRestart() ? { routeHandoff: true } : {}),
      });
      if (canRestart()) {
        const outcomes = await params.startChannel(channel, accountId, {
          reason: "config-reload",
          preserveManualStop: true,
          skipUnavailableAccounts: true,
        });
        for (const [id, outcome] of outcomes) {
          if (outcome.status === "retry") {
            throw new Error(`${channel}[${id}] replacement not admitted: ${outcome.reason}`);
          }
        }
      } else {
        params.releaseChannelRouteHandoffs(channel, accountId);
      }
    } catch (err) {
      failures.push(accountId === undefined ? channel : `${channel}[${accountId}]`);
      params.logChannels.error(
        `failed to ${removed ? "stop" : operation} ${target} during ${phase}: ${formatErrorMessage(err)}`,
      );
    }
  }
  if (failures.length > 0) {
    scheduleRecoveryRestart(`channel ${operation} (${failures.join(", ")})`);
  }
  if (suppressed) {
    const channels = new Set([...channelsToRestart, ...restartChannelAccounts.keys()]);
    if (getChannelAutostartSuppression()) {
      params.logChannels.info(
        `channel restart during hot reload suppressed by crash-loop breaker for channels: ${[...channels].join(", ")}`,
      );
    }
  }
}
