import {
  getChannelPlugin,
  listChannelPlugins,
  resolveChannelApprovalAdapter,
  resolveChannelApprovalCapability,
} from "../channels/plugins/index.js";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { parseRawSessionConversationRef } from "../sessions/session-key-utils.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";

export type ExecApprovalInitiatingSurfaceState =
  | { kind: "enabled"; channel: string | undefined; channelLabel: string }
  | { kind: "disabled"; channel: string; channelLabel: string }
  | { kind: "unsupported"; channel: string; channelLabel: string };

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

function isBlueBubblesGroupTurnSource(params: {
  channel?: string;
  turnSourceTo?: string | null;
  sessionKey?: string | null;
}): boolean {
  if (params.channel !== "bluebubbles") {
    return false;
  }

  const sessionRef = parseRawSessionConversationRef(params.sessionKey);
  if (
    sessionRef &&
    sessionRef.channel === "bluebubbles" &&
    (sessionRef.kind === "group" || sessionRef.kind === "channel")
  ) {
    return true;
  }

  const rawTo = params.turnSourceTo?.trim().toLowerCase();
  if (!rawTo) {
    return false;
  }
  const stripped = rawTo.startsWith("bluebubbles:") ? rawTo.slice("bluebubbles:".length) : rawTo;
  if (
    stripped.startsWith("group:") ||
    stripped.startsWith("chat_id:") ||
    stripped.startsWith("chat_identifier:")
  ) {
    return true;
  }
  if (stripped.startsWith("chat_guid:")) {
    return stripped.includes(";+;");
  }
  return false;
}

function hasDeliverableExecForwardTargets(cfg: OpenClawConfig): boolean {
  return (cfg.approvals?.exec?.targets ?? []).some((target) => {
    const to = target.to?.trim();
    const channel = normalizeMessageChannel(target.channel);
    return Boolean(to && channel && isDeliverableMessageChannel(channel));
  });
}

function shouldDisableInitiatingSurfaceForExecTargetsOnly(params: {
  cfg: OpenClawConfig;
  sessionKey?: string | null;
}): boolean {
  const forwardingCfg = params.cfg.approvals?.exec;
  if (!forwardingCfg?.enabled) {
    return false;
  }
  if ((forwardingCfg.mode ?? "session") !== "targets") {
    return false;
  }
  if (
    !matchesApprovalRequestFilters({
      request: { sessionKey: params.sessionKey },
      agentFilter: forwardingCfg.agentFilter,
      sessionFilter: forwardingCfg.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  ) {
    return false;
  }
  return hasDeliverableExecForwardTargets(params.cfg);
}

export function resolveExecApprovalInitiatingSurfaceState(params: {
  channel?: string | null;
  accountId?: string | null;
  turnSourceTo?: string | null;
  sessionKey?: string | null;
  cfg?: OpenClawConfig;
}): ExecApprovalInitiatingSurfaceState {
  const channel = normalizeMessageChannel(params.channel);
  const channelLabel = labelForChannel(channel);
  const cfg = params.cfg ?? loadConfig() ?? {};
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL || channel === "tui") {
    // When the source channel metadata is unavailable, targets-only routing still
    // means approvals should be handled by configured approval targets.
    if (
      !channel &&
      shouldDisableInitiatingSurfaceForExecTargetsOnly({
        cfg,
        sessionKey: params.sessionKey,
      })
    ) {
      return { kind: "disabled", channel: "session", channelLabel };
    }
    return { kind: "enabled", channel, channelLabel };
  }

  // In explicit targets-only mode, keep approvals centralized in configured targets.
  if (
    shouldDisableInitiatingSurfaceForExecTargetsOnly({
      cfg,
      sessionKey: params.sessionKey,
    })
  ) {
    return { kind: "disabled", channel, channelLabel };
  }

  // BlueBubbles group chats should not receive /approve command prompts inline.
  if (
    isBlueBubblesGroupTurnSource({
      channel,
      turnSourceTo: params.turnSourceTo,
      sessionKey: params.sessionKey,
    })
  ) {
    return { kind: "disabled", channel, channelLabel };
  }

  const state = resolveChannelApprovalCapability(
    getChannelPlugin(channel),
  )?.getActionAvailabilityState?.({
    cfg,
    accountId: params.accountId,
    action: "approve",
  });
  if (state) {
    return { ...state, channel, channelLabel };
  }
  if (isDeliverableMessageChannel(channel)) {
    return { kind: "enabled", channel, channelLabel };
  }
  return { kind: "unsupported", channel, channelLabel };
}

export function hasConfiguredExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listChannelPlugins().some(
    (plugin) =>
      resolveChannelApprovalAdapter(plugin)?.delivery?.hasConfiguredDmRoute?.({ cfg }) ?? false,
  );
}
