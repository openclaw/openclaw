import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { canChannelEnforcePluginReviewerPolicy } from "./approval-channel-policy-support.js";
import type { ChannelApprovalKind } from "./approval-types.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

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
  if (!capability?.native && !capability?.nativeAsync) {
    return false;
  }
  return Boolean(
    capability.getExecInitiatingSurfaceStateAsync ||
    capability.getExecInitiatingSurfaceState ||
    capability.getActionAvailabilityState,
  );
}

export function resolveExecApprovalInitiatingSurfaceStateAsync(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): Promise<ExecApprovalInitiatingSurfaceState> {
  return resolveApprovalInitiatingSurfaceStateAsync({ ...params, approvalKind: "exec" });
}

export async function resolveApprovalInitiatingSurfaceStateAsync(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  approvalKind: ChannelApprovalKind;
  request?: PluginApprovalRequest;
}): Promise<ExecApprovalInitiatingSurfaceState> {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  const accountId = normalizeOptionalString(params.accountId);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel, accountId };
  }

  const cfg = params.cfg ?? getRuntimeConfig();
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  if (
    params.approvalKind === "plugin" &&
    !canChannelEnforcePluginReviewerPolicy(cfg, channel, capability)
  ) {
    return { kind: "disabled", channel, channelLabel, accountId };
  }
  // Prefer worker-owned exec availability; config-only plugins can keep their sync hook.
  const execHook =
    capability?.getExecInitiatingSurfaceStateAsync ?? capability?.getExecInitiatingSurfaceState;
  const state =
    (params.approvalKind === "exec"
      ? await execHook?.({ cfg, accountId: params.accountId, action: "approve" })
      : undefined) ??
    capability?.getActionAvailabilityState?.({
      cfg,
      accountId: params.accountId,
      action: "approve",
      approvalKind: params.approvalKind,
      ...(params.request ? { request: params.request } : {}),
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
    .map((plugin) => normalizeOptionalString(plugin.meta.label))
    .filter((label): label is string => Boolean(label))
    .toSorted((a, b) => a.localeCompare(b));
}

type NativeApprovalClientSetupParams = {
  channel?: string | null;
  channelLabel?: string | null;
  accountId?: string | null;
};

function describeNativeApprovalClientSetup(
  params: NativeApprovalClientSetupParams,
  approvalKind: ChannelApprovalKind,
): string | null {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return null;
  }
  const channelLabel = normalizeOptionalString(params.channelLabel) ?? labelForChannel(channel);
  const accountId = normalizeOptionalString(params.accountId);
  const capability = resolveChannelApprovalCapability(getChannelPlugin(channel));
  const setupParams = { channel, channelLabel, accountId };
  return approvalKind === "exec"
    ? (capability?.describeExecApprovalSetup?.(setupParams) ?? null)
    : (capability?.describePluginApprovalSetup?.(setupParams) ?? null);
}

export function describeNativeExecApprovalClientSetup(
  params: NativeApprovalClientSetupParams,
): string | null {
  return describeNativeApprovalClientSetup(params, "exec");
}

export function describeNativePluginApprovalClientSetup(
  params: NativeApprovalClientSetupParams,
): string | null {
  return describeNativeApprovalClientSetup(params, "plugin");
}
