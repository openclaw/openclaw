import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import { handleSlackMessageAction } from "../../plugin-sdk/slack-message-actions.js";
import {
  extractSlackToolSend,
  isSlackInteractiveRepliesEnabled,
  listSlackMessageActions,
  resolveSlackChannelId,
} from "../../plugin-sdk/slack.js";
import type { ChannelMessageActionAdapter } from "./types.js";

export function createSlackActions(providerId: string): ChannelMessageActionAdapter {
  return {
    listActions: ({ cfg }) => listSlackMessageActions(cfg),
    getCapabilities: ({ cfg }) => {
      const capabilities = new Set<"interactive" | "blocks">();
      if (listSlackMessageActions(cfg).includes("send")) {
        capabilities.add("blocks");
      }
      if (isSlackInteractiveRepliesEnabled({ cfg })) {
        capabilities.add("interactive");
      }
      return Array.from(capabilities);
    },
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    handleAction: async (ctx) => {
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: resolveSlackChannelId,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await handleSlackAction(action, cfg, {
            ...(toolContext as SlackActionContext | undefined),
            mediaLocalRoots: ctx.mediaLocalRoots,
          }),
      });
    },
  };
}
