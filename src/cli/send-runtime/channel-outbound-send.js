import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { loadConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
function resolveRuntimeThreadId(opts) {
    return opts.messageThreadId ?? opts.threadId ?? opts.threadTs ?? undefined;
}
function resolveRuntimeReplyToId(opts) {
    const raw = opts.replyToMessageId ?? opts.replyToId;
    return raw == null ? undefined : normalizeOptionalString(String(raw));
}
export function createChannelOutboundRuntimeSend(params) {
    return {
        sendMessage: async (to, text, opts = {}) => {
            const outbound = await loadChannelOutboundAdapter(params.channelId);
            const threadId = resolveRuntimeThreadId(opts);
            const replyToId = resolveRuntimeReplyToId(opts);
            const buildContext = () => ({
                cfg: opts.cfg ?? loadConfig(),
                to,
                text,
                mediaUrl: opts.mediaUrl,
                mediaAccess: opts.mediaAccess,
                mediaLocalRoots: opts.mediaLocalRoots,
                mediaReadFile: opts.mediaReadFile,
                accountId: opts.accountId,
                threadId,
                replyToId,
                silent: opts.silent,
                forceDocument: opts.forceDocument,
                gifPlayback: opts.gifPlayback,
                gatewayClientScopes: opts.gatewayClientScopes,
            });
            const hasMedia = Boolean(opts.mediaUrl);
            if (hasMedia && outbound?.sendMedia) {
                return await outbound.sendMedia(buildContext());
            }
            if (!outbound?.sendText) {
                throw new Error(params.unavailableMessage);
            }
            return await outbound.sendText(buildContext());
        },
    };
}
