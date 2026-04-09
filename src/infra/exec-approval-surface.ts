import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalAdapter,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string; accountId?: string }
  | { kind: "disabled"; channel: string; channelLabel: string; accountId?: string }
  | { kind: "unsupported"; channel: string; channelLabel: string; accountId?: string };

function labelForChannel(channel?: string): string {
  if (channel === "tui") {
    return "terminal UI";
  }
  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return "Web UI";
  }
  return (
    getChannelPlugin(channel ?? "")?.meta.label ??
    (channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform")
  );
}

function hasNativeExecApprovalCapability(channel?: string): boolean {
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel ?? ""));
  return Boolean(capability?.native && capability.getActionAvailabilityState);
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  const accountId = params.accountId?.trim() || undefined;
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel, accountId };
  }

  const cfg = params.cfg ?? loadConfig();
  const state = resolveChannelApprovalCapability(
    getChannelPlugin(channel),
  )?.getActionAvailabilityState?.({
    cfg,
    accountId: params.accountId,
    action: "approve",
  });
  if (state) {
    return { ...state, channel, channelLabel, accountId };
  }
  if (isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel, accountId };
  }
  return { kind: "unsupported", channel, channelLabel, accountId };
}

export function supportsNativeExecApprovalClient(channel?: string | null): boolean {
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || normalized === INTERNAL_MESSAGE_CHANNEL || normalized === "tui") {
    return true;
  }
  return hasNativeExecApprovalCapability(normalized);
}

export function listNativeExecApprovalClientLabels(params?: {
  excludeChannel?: string | null;
}): string[] {
  const excludeChannel = normalizeMessageChannel(params?.excludeChannel);
  return listChannelPlugins()
    .filter((plugin) => plugin.id !== excludeChannel)
    .filter((plugin) => hasNativeExecApprovalCapability(plugin.id))
    .map((plugin) => plugin.meta.label?.trim())
    .filter((label): label is string => Boolean(label))
    .toSorted((a, b) => a.localeCompare(b));
}

export function describeNativeExecApprovalClientSetup(params: {
  channel?: string | null;
  channelLabel?: string | null;
  accountId?: string | null;
}): string | null {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return null;
  }
  const channelLabel = params.channelLabel?.trim() || labelForChannel(channel);
  const accountId = params.accountId?.trim() || undefined;
  return (
    resolveChannelApprovalCapability(getChannelPlugin(channel))?.describeExecApprovalSetup?.({
      channel,
      channelLabel,
      accountId,
    }) ?? null
  );
}

export function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listChannelPlugins().some(
    (plugin) =>
      resolveChannelApprovalAdapter(plugin)?.delivery?.hasConfiguredDmRoute?.({ cfg }) ?? false,
  );
}
