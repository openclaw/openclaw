import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
import { createReplyPrefixContext, createReplyPrefixOptions, } from "../channels/reply-prefix.js";
import { createTypingCallbacks, } from "../channels/typing.js";
export { createReplyPrefixContext, createReplyPrefixOptions, createTypingCallbacks };
export function createChannelReplyPipeline(params) {
    const channelId = params.channel
        ? (normalizeChannelId(params.channel) ?? params.channel)
        : undefined;
    let plugin;
    let pluginTransformResolved = false;
    const resolvePluginTransform = () => {
        if (pluginTransformResolved) {
            return plugin?.messaging?.transformReplyPayload;
        }
        pluginTransformResolved = true;
        plugin = channelId ? getChannelPlugin(channelId) : undefined;
        return plugin?.messaging?.transformReplyPayload;
    };
    const transformReplyPayload = params.transformReplyPayload
        ? params.transformReplyPayload
        : channelId
            ? (payload) => resolvePluginTransform()?.({
                payload,
                cfg: params.cfg,
                accountId: params.accountId,
            }) ?? payload
            : undefined;
    return {
        ...createReplyPrefixOptions({
            cfg: params.cfg,
            agentId: params.agentId,
            channel: params.channel,
            accountId: params.accountId,
        }),
        ...(transformReplyPayload ? { transformReplyPayload } : {}),
        ...(params.typingCallbacks
            ? { typingCallbacks: params.typingCallbacks }
            : params.typing
                ? { typingCallbacks: createTypingCallbacks(params.typing) }
                : {}),
    };
}
