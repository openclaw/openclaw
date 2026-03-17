import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import {
  extractSlackToolSend,
  isSlackInteractiveRepliesEnabled,
  listSlackMessageActions,
  resolveSlackChannelId,
} from "../../plugin-sdk-internal/slack.js";
import { handleSlackMessageAction } from "../../plugin-sdk/slack-message-actions.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionContext } from "./types.js";

type SlackActionAdapterOptions = {
  includeReadThreadId?: boolean;
  invoke?: (
    ctx: ChannelMessageActionContext,
  ) => Parameters<typeof handleSlackMessageAction>[0]["invoke"];
  skipNormalizeChannelId?: boolean;
};

export function createSlackActions(
  providerId: string,
  options?: SlackActionAdapterOptions,
): ChannelMessageActionAdapter {
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
      const invoke =
        options?.invoke?.(ctx) ??
        (async (action, cfg, toolContext) =>
          await handleSlackAction(action, cfg, {
            ...(toolContext as SlackActionContext | undefined),
            mediaLocalRoots: ctx.mediaLocalRoots,
          }));
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: options?.skipNormalizeChannelId ? undefined : resolveSlackChannelId,
        includeReadThreadId: options?.includeReadThreadId ?? true,
        invoke,
      });
    },
  };
}
