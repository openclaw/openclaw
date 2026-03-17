import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { handleSlackAction, type SlackActionContext } from "../../agents/tools/slack-actions.js";
import {
  extractSlackToolSend,
  isSlackInteractiveRepliesEnabled,
  listSlackMessageActions,
  resolveSlackChannelId,
  handleSlackMessageAction,
} from "../../plugin-sdk/slack.js";
import type { ChannelMessageActionAdapter } from "./types.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: unknown,
  toolContext: unknown,
) => Promise<AgentToolResult<unknown>>;

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
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
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: resolveSlackChannelId,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await (options?.invoke
            ? options.invoke(action, cfg, toolContext)
            : handleSlackAction(action, cfg, {
                ...(toolContext as SlackActionContext | undefined),
                mediaLocalRoots: ctx.mediaLocalRoots,
              })),
      });
    },
  };
}
