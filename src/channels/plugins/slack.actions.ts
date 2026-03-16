import { isSlackInteractiveRepliesEnabled } from "../../../extensions/slack/src/interactive-replies.js";
import {
  extractSlackToolSend,
  listSlackMessageActions,
} from "../../../extensions/slack/src/message-actions.js";
import { resolveSlackChannelId } from "../../../extensions/slack/src/targets.js";
import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import { handleSlackMessageAction } from "../../plugin-sdk/slack-message-actions.js";
import type { ChannelMessageActionAdapter } from "./types.js";

export function createSlackActions(providerId: string): ChannelMessageActionAdapter {
  return {
    listActions: ({ cfg }) => listSlackMessageActions(cfg),
    supportsInteractive: ({ cfg }) => isSlackInteractiveRepliesEnabled({ cfg }),
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
