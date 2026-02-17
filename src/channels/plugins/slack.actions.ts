import type { ChannelMessageActionAdapter } from "./types.js";
import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import { handleSlackMessageAction } from "../../plugin-sdk/slack-message-actions.js";
import { extractSlackToolSend, listSlackMessageActions } from "../../slack/message-actions.js";
import { resolveSlackChannelId } from "../../slack/targets.js";

export function createSlackActions(providerId: string): ChannelMessageActionAdapter {
  return {
    listActions: ({ cfg }) => listSlackMessageActions(cfg),
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    handleAction: async (ctx) => {
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: resolveSlackChannelId,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await handleSlackAction(action, cfg, toolContext as SlackActionContext | undefined),
      });
    },
  };
}
