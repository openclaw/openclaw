// Shared test support for the message-tool suites: the channel-plugin factory used by
// both message-tool.test.ts and message-tool.turn-send-budget.test.ts to install minimal
// loaded channel plugins. Kept here so the focused per-turn-send-budget suite reuses the
// exact plugin shape the main suite exercises instead of a divergent copy.
import type { ChannelMessageAdapterShape } from "../../channels/message/types.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName, ChannelPlugin } from "../../channels/plugins/types.js";

// Shape of the object the message tool passes into runMessageAction. Shared by both
// suites so their runner-mock assertions read the same fields the production call site
// populates.
export type RunMessageActionInput = {
  actionOrigin?: "message-tool";
  agentId?: string;
  broadcastAccountPlan?: {
    accountId: string;
    candidateChannels: string[];
    secretChannels: string[];
  };
  cfg?: unknown;
  conversationReadOrigin?: "delegated" | "direct-operator";
  executionIdentityToken?: unknown;
  defaultAccountId?: string;
  gateway?: {
    timeoutMs?: unknown;
    terminalSourceReplyReceiptOwner?: "caller";
    resolveAgentRuntimeIdentityToken?: (context?: {
      sourceReplyFinal?: boolean;
      sourceReplyToolCallId?: string;
    }) => Promise<string | undefined>;
  };
  params?: Record<string, unknown>;
  requesterAccountId?: string;
  requesterSenderId?: string;
  requesterSenderName?: string;
  requesterSenderUsername?: string;
  requesterSenderE164?: string;
  runId?: string;
  messageActionAuthorization?: {
    requesterAccountId?: string;
    requesterSenderId?: string;
    toolContext?: RunMessageActionInput["toolContext"];
  };
  sandboxRoot?: string;
  sessionKey?: string;
  sourceReplyDeliveryMode?: string;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  inboundAudio?: boolean;
  toolContext?: {
    currentChannelId?: string;
    currentChatType?: string;
    currentMessagingTarget?: string;
    currentChannelProvider?: string;
    currentThreadTs?: string;
    replyToMode?: string;
  };
};

type DescribeMessageTool = NonNullable<
  NonNullable<ChannelPlugin["actions"]>["describeMessageTool"]
>;
type MessageToolDiscoveryContext = Parameters<DescribeMessageTool>[0];
type MessageToolSchema = NonNullable<ReturnType<DescribeMessageTool>>["schema"];

export function createChannelPlugin(params: {
  id: string;
  label: string;
  docsPath: string;
  blurb: string;
  aliases?: string[];
  actions?: ChannelMessageActionName[];
  capabilities?: readonly ChannelMessageCapability[];
  toolSchema?: MessageToolSchema | ((params: MessageToolDiscoveryContext) => MessageToolSchema);
  describeMessageTool?: DescribeMessageTool;
  messageActionTargetAliases?: NonNullable<ChannelPlugin["actions"]>["messageActionTargetAliases"];
  config?: Partial<ChannelPlugin["config"]>;
  message?: ChannelMessageAdapterShape;
  messaging?: ChannelPlugin["messaging"];
  outbound?: ChannelPlugin["outbound"];
}): ChannelPlugin {
  return {
    id: params.id as ChannelPlugin["id"],
    meta: {
      id: params.id as ChannelPlugin["id"],
      label: params.label,
      selectionLabel: params.label,
      docsPath: params.docsPath,
      blurb: params.blurb,
      aliases: params.aliases,
    },
    capabilities: { chatTypes: ["direct", "group"], media: true },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      ...params.config,
    },
    ...(params.message ? { message: params.message } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
    ...(params.outbound ? { outbound: params.outbound } : {}),
    actions: {
      describeMessageTool:
        params.describeMessageTool ??
        ((ctx) => {
          const schema =
            typeof params.toolSchema === "function" ? params.toolSchema(ctx) : params.toolSchema;
          return {
            actions: params.actions ?? [],
            capabilities: params.capabilities,
            ...(schema ? { schema } : {}),
          };
        }),
      messageActionTargetAliases: params.messageActionTargetAliases,
    },
  };
}
