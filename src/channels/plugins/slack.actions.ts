import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import { resolveAgentOutboundIdentity } from "../../infra/outbound/identity.js";
import { handleSlackMessageAction } from "../../plugin-sdk/slack-message-actions.js";
import { extractSlackToolSend, listSlackMessageActions } from "../../slack/message-actions.js";
import type { SlackSendIdentity } from "../../slack/send.js";
import { resolveSlackChannelId } from "../../slack/targets.js";
import type { ChannelMessageActionAdapter } from "./types.js";

function resolveSlackIdentityFromAgent(
  cfg: Parameters<typeof resolveAgentOutboundIdentity>[0],
  agentId: string | undefined,
): SlackSendIdentity | undefined {
  if (!agentId) return undefined;
  const outbound = resolveAgentOutboundIdentity(cfg, agentId);
  if (!outbound) return undefined;
  return {
    username: outbound.name,
    iconUrl: outbound.avatarUrl,
    iconEmoji: outbound.emoji,
  };
}

export function createSlackActions(providerId: string): ChannelMessageActionAdapter {
  return {
    listActions: ({ cfg }) => listSlackMessageActions(cfg),
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    handleAction: async (ctx) => {
      const agentId =
        typeof ctx.params.__agentId === "string" ? ctx.params.__agentId : undefined;
      const identity = resolveSlackIdentityFromAgent(ctx.cfg, agentId);
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: resolveSlackChannelId,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await handleSlackAction(action, cfg, {
            ...(toolContext as SlackActionContext | undefined),
            mediaLocalRoots: ctx.mediaLocalRoots,
            ...(identity ? { identity } : {}),
          }),
      });
    },
  };
}
