import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  handleSlackAction,
  type SlackActionContext,
} from "../../../extensions/slack/runtime-api.js";
import {
  extractSlackToolSend,
  isSlackInteractiveRepliesEnabled,
  listSlackMessageActions,
  resolveSlackChannelId,
  handleSlackMessageAction,
} from "../../plugin-sdk/slack.js";
import { createLegacyMessageToolDiscoveryMethods } from "./message-tool-legacy.js";
import { createSlackMessageToolBlocksSchema } from "./message-tool-schema.js";
import type { ChannelMessageActionAdapter, ChannelMessageToolDiscovery } from "./types.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: unknown,
  toolContext: unknown,
) => Promise<AgentToolResult<unknown>>;

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
): ChannelMessageActionAdapter {
  function describeMessageTool({
    cfg,
  }: Parameters<
    NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
  >[0]): ChannelMessageToolDiscovery {
    const actions = listSlackMessageActions(cfg);
    const capabilities = new Set<"blocks" | "interactive">();
    if (actions.includes("send")) {
      capabilities.add("blocks");
    }
    if (isSlackInteractiveRepliesEnabled({ cfg })) {
      capabilities.add("interactive");
    }
    return {
      actions,
      capabilities: Array.from(capabilities),
      schema: actions.includes("send")
        ? {
            properties: {
              blocks: createSlackMessageToolBlocksSchema(),
            },
          }
        : null,
    };
  }

  return {
    describeMessageTool,
    ...createLegacyMessageToolDiscoveryMethods(describeMessageTool),
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
