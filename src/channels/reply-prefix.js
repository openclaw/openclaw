import { resolveEffectiveMessagesConfig, resolveIdentityName } from "../agents/identity.js";
import { extractShortModelName, } from "../auto-reply/reply/response-prefix-template.js";
export function createReplyPrefixContext(params) {
    const { cfg, agentId } = params;
    const prefixContext = {
        identityName: resolveIdentityName(cfg, agentId),
    };
    const onModelSelected = (ctx) => {
        // Mutate the object directly instead of reassigning to ensure closures see updates.
        prefixContext.provider = ctx.provider;
        prefixContext.model = extractShortModelName(ctx.model);
        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
    };
    return {
        prefixContext,
        responsePrefix: resolveEffectiveMessagesConfig(cfg, agentId, {
            channel: params.channel,
            accountId: params.accountId,
        }).responsePrefix,
        responsePrefixContextProvider: () => prefixContext,
        onModelSelected,
    };
}
export function createReplyPrefixOptions(params) {
    const { responsePrefix, responsePrefixContextProvider, onModelSelected } = createReplyPrefixContext(params);
    return { responsePrefix, responsePrefixContextProvider, onModelSelected };
}
