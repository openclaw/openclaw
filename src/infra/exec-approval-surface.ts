import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
import { DEFAULT_EXEC_APPROVAL_TIMEOUT_MS } from "./exec-approvals.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string }
  | { kind: "disabled"; channel: string; channelLabel: string }
  | { kind: "unsupported"; channel: string; channelLabel: string };

function labelForChannel(channel?: string): string {
  switch (channel) {
    case "discord":
      return "Discord";
    case "telegram":
      return "Telegram";
    case "tui":
      return "terminal UI";
    case INTERNAL_MESSAGE_CHANNEL:
      return "Web UI";
    default:
      return channel ? channel[0]?.toUpperCase() + channel.slice(1) : "this platform";
  }
}

function normalizeTimeoutMs(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return { kind: "enabled", channel, channelLabel };
  }

  const cfg = params.cfg ?? loadConfig();
  const state = getChannelPlugin(channel)?.execApprovals?.getInitiatingSurfaceState?.({
    cfg,
    accountId: params.accountId,
  });
  if (state) {
    return { ...state, channel, channelLabel };
  }
  return { kind: "unsupported", channel, channelLabel };
}

export function resolveExecApprovalTimeoutMs(params: {
  channel?: string | null;
  accountId?: string | null;
  cfg?: OpenClawConfig;
  defaultTimeoutMs?: number;
}): number {
  const defaultTimeoutMs = normalizeTimeoutMs(
    params.defaultTimeoutMs,
    DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  );
  const channel = normalizeMessageChannel(params.channel);
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    return defaultTimeoutMs;
  }

  const cfg = params.cfg ?? loadConfig();
  return normalizeTimeoutMs(
    getChannelPlugin(channel)?.execApprovals?.resolveApprovalTimeoutMs?.({
      cfg,
      accountId: params.accountId,
      defaultTimeoutMs,
    }),
    defaultTimeoutMs,
  );
}

export function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listChannelPlugins().some(
    (plugin) => plugin.execApprovals?.hasConfiguredDmRoute?.({ cfg }) ?? false,
  );
}
