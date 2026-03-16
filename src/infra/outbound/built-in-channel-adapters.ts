import { Separator, TextDisplay } from "@buape/carbon";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../../../extensions/discord/src/accounts.js";
import { isDiscordExecApprovalClientEnabled } from "../../../extensions/discord/src/exec-approvals.js";
import { DiscordUiContainer } from "../../../extensions/discord/src/ui.js";
import { listTelegramAccountIds } from "../../../extensions/telegram/src/accounts.js";
import { buildTelegramExecApprovalButtons } from "../../../extensions/telegram/src/approval-buttons.js";
import {
  isTelegramExecApprovalClientEnabled,
  resolveTelegramExecApprovalTarget,
} from "../../../extensions/telegram/src/exec-approvals.js";
import type { ChannelExecApprovalAdapter } from "../../channels/plugins/types.adapters.js";
import type { ChannelCrossContextComponentsFactory } from "../../channels/plugins/types.core.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveExecApprovalCommandDisplay } from "../exec-approval-command-display.js";
import { buildExecApprovalPendingReplyPayload } from "../exec-approval-reply.js";

const BUILT_IN_DISCORD_CROSS_CONTEXT_COMPONENTS: ChannelCrossContextComponentsFactory = (
  params,
) => {
  const trimmed = params.message.trim();
  const components: Array<TextDisplay | Separator> = [];
  if (trimmed) {
    components.push(new TextDisplay(params.message));
    components.push(new Separator({ divider: true, spacing: "small" }));
  }
  components.push(new TextDisplay(`*From ${params.originLabel}*`));
  return [new DiscordUiContainer({ cfg: params.cfg, accountId: params.accountId, components })];
};

function hasDiscordExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listDiscordAccountIds(cfg).some((accountId) => {
    const execApprovals = resolveDiscordAccount({ cfg, accountId }).config.execApprovals;
    if (!execApprovals?.enabled || (execApprovals.approvers?.length ?? 0) === 0) {
      return false;
    }
    const target = execApprovals.target ?? "dm";
    return target === "dm" || target === "both";
  });
}

function hasTelegramExecApprovalDmRoute(cfg: OpenClawConfig): boolean {
  return listTelegramAccountIds(cfg).some((accountId) => {
    if (!isTelegramExecApprovalClientEnabled({ cfg, accountId })) {
      return false;
    }
    const target = resolveTelegramExecApprovalTarget({ cfg, accountId });
    return target === "dm" || target === "both";
  });
}

const BUILT_IN_DISCORD_EXEC_APPROVALS: ChannelExecApprovalAdapter = {
  getInitiatingSurfaceState: ({ cfg, accountId }) =>
    isDiscordExecApprovalClientEnabled({ cfg, accountId })
      ? { kind: "enabled" }
      : { kind: "disabled" },
  hasConfiguredDmRoute: ({ cfg }) => hasDiscordExecApprovalDmRoute(cfg),
  shouldSuppressForwardingFallback: ({ cfg, target }) =>
    (normalizeMessageChannel(target.channel) ?? target.channel) === "discord" &&
    isDiscordExecApprovalClientEnabled({ cfg, accountId: target.accountId }),
};

const BUILT_IN_TELEGRAM_EXEC_APPROVALS: ChannelExecApprovalAdapter = {
  getInitiatingSurfaceState: ({ cfg, accountId }) =>
    isTelegramExecApprovalClientEnabled({ cfg, accountId })
      ? { kind: "enabled" }
      : { kind: "disabled" },
  hasConfiguredDmRoute: ({ cfg }) => hasTelegramExecApprovalDmRoute(cfg),
  shouldSuppressForwardingFallback: ({ cfg, target, request }) => {
    const channel = normalizeMessageChannel(target.channel) ?? target.channel;
    if (channel !== "telegram") {
      return false;
    }
    const requestChannel = normalizeMessageChannel(request.request.turnSourceChannel ?? "");
    if (requestChannel !== "telegram") {
      return false;
    }
    const accountId = target.accountId?.trim() || request.request.turnSourceAccountId?.trim();
    return isTelegramExecApprovalClientEnabled({ cfg, accountId });
  },
  buildPendingPayload: ({ request, nowMs }) => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommandId: request.id,
      command: resolveExecApprovalCommandDisplay(request.request).commandText,
      cwd: request.request.cwd ?? undefined,
      host: request.request.host === "node" ? "node" : "gateway",
      nodeId: request.request.nodeId ?? undefined,
      expiresAtMs: request.expiresAtMs,
      nowMs,
    });
    const buttons = buildTelegramExecApprovalButtons(request.id);
    if (!buttons) {
      return payload;
    }
    return {
      ...payload,
      channelData: {
        ...payload.channelData,
        telegram: { buttons },
      },
    };
  },
};

export function resolveBuiltInCrossContextComponentsFactory(
  channel: ChannelId,
): ChannelCrossContextComponentsFactory | undefined {
  return channel === "discord" ? BUILT_IN_DISCORD_CROSS_CONTEXT_COMPONENTS : undefined;
}

export function resolveBuiltInExecApprovalAdapter(
  channel: ChannelId,
): ChannelExecApprovalAdapter | undefined {
  if (channel === "discord") {
    return BUILT_IN_DISCORD_EXEC_APPROVALS;
  }
  if (channel === "telegram") {
    return BUILT_IN_TELEGRAM_EXEC_APPROVALS;
  }
  return undefined;
}
