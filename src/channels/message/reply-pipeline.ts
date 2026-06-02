import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  resolveSourceReplyDeliveryMode,
  type SourceReplyDeliveryModeContext,
} from "../../auto-reply/reply/source-reply-delivery-mode.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getLoadedChannelPluginForRead } from "../plugins/registry-loaded-read.js";
import { normalizeAnyChannelId } from "../registry-normalize.js";
import {
  createReplyPrefixContext,
  createReplyPrefixOptions,
  type ReplyPrefixContextBundle,
  type ReplyPrefixOptions,
} from "../reply-prefix.js";
import {
  createTypingCallbacks,
  type CreateTypingCallbacksParams,
  type TypingCallbacks,
} from "../typing.js";

export type ReplyPrefixContext = ReplyPrefixContextBundle["prefixContext"];
export type { ReplyPrefixContextBundle, ReplyPrefixOptions };
export type { CreateTypingCallbacksParams, TypingCallbacks };
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };
export type { SourceReplyDeliveryMode };

/** Resolves whether a channel reply should use source delivery, message tools, or direct sending. */
export function resolveChannelSourceReplyDeliveryMode(params: {
  cfg: OpenClawConfig;
  ctx: SourceReplyDeliveryModeContext;
  requested?: SourceReplyDeliveryMode;
  messageToolAvailable?: boolean;
}): SourceReplyDeliveryMode {
  return resolveSourceReplyDeliveryMode(params);
}

/** Reply pipeline options shared by core channel turns and plugin SDK callers. */
export type ChannelReplyPipeline = ReplyPrefixOptions & {
  typingCallbacks?: TypingCallbacks;
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};

/** Parameters for building a channel reply pipeline with prefix, typing, and payload transforms. */
export type CreateChannelReplyPipelineParams = {
  cfg: Parameters<typeof createReplyPrefixOptions>[0]["cfg"];
  agentId: string;
  /** Channel id used for prefix policy and lazy plugin reply transforms. */
  channel?: string;
  /** Account id passed to channel-owned reply transforms. */
  accountId?: string;
  typing?: CreateTypingCallbacksParams;
  typingCallbacks?: TypingCallbacks;
  /** Caller override that runs instead of the channel plugin transform. */
  transformReplyPayload?: (payload: ReplyPayload) => ReplyPayload | null;
};

/** Builds the reply pipeline used by channel turns and plugin SDK reply helpers. */
export function createChannelReplyPipeline(
  params: CreateChannelReplyPipelineParams,
): ChannelReplyPipeline {
  const channelId = params.channel
    ? (normalizeAnyChannelId(params.channel) ?? params.channel)
    : undefined;
  let plugin: ReturnType<typeof getLoadedChannelPluginForRead> | undefined;
  let pluginTransformResolved = false;
  const resolvePluginTransform = () => {
    // Load the channel plugin lazily and at most once so reply-pipeline
    // construction stays cheap for hot turn paths that never send a reply.
    if (pluginTransformResolved) {
      return plugin?.messaging?.transformReplyPayload;
    }
    pluginTransformResolved = true;
    plugin = channelId ? getLoadedChannelPluginForRead(channelId) : undefined;
    return plugin?.messaging?.transformReplyPayload;
  };
  const transformReplyPayload = params.transformReplyPayload
    ? params.transformReplyPayload
    : channelId
      ? (payload: ReplyPayload) => {
          // Channel-owned transforms run after prefix/typing setup, but an
          // explicit caller transform above bypasses registry lookup entirely.
          return (
            resolvePluginTransform()?.({
              payload,
              cfg: params.cfg,
              accountId: params.accountId,
            }) ?? payload
          );
        }
      : undefined;
  const typingCallbacks = params.typingCallbacks
    ? params.typingCallbacks
    : params.typing
      ? createTypingCallbacks(params.typing)
      : undefined;
  // Preserve prebuilt callbacks for channels with custom lifecycle hooks;
  // otherwise synthesize callbacks only when typing config is provided.
  return {
    ...createReplyPrefixOptions({
      cfg: params.cfg,
      agentId: params.agentId,
      channel: params.channel,
      accountId: params.accountId,
    }),
    ...(transformReplyPayload ? { transformReplyPayload } : {}),
    ...(typingCallbacks ? { typingCallbacks } : {}),
  };
}
