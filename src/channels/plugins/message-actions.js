import { getChannelPlugin, listChannelPlugins } from "./index.js";
const trustedRequesterRequiredByChannel = {
    discord: new Set(["timeout", "kick", "ban"]),
};
function requiresTrustedRequesterSender(ctx) {
    const actions = trustedRequesterRequiredByChannel[ctx.channel];
    return Boolean(actions?.has(ctx.action) && ctx.toolContext);
}
export function listChannelMessageActions(cfg) {
    const actions = new Set(["send", "broadcast"]);
    for (const plugin of listChannelPlugins()) {
        const list = plugin.actions?.listActions?.({ cfg });
        if (!list) {
            continue;
        }
        for (const action of list) {
            actions.add(action);
        }
    }
    return Array.from(actions);
}
export function supportsChannelMessageButtons(cfg) {
    return supportsMessageFeature(cfg, (actions) => actions?.supportsButtons?.({ cfg }) === true);
}
export function supportsChannelMessageButtonsForChannel(params) {
    return supportsMessageFeatureForChannel(params, (actions) => actions.supportsButtons?.(params) === true);
}
export function supportsChannelMessageCards(cfg) {
    return supportsMessageFeature(cfg, (actions) => actions?.supportsCards?.({ cfg }) === true);
}
export function supportsChannelMessageCardsForChannel(params) {
    return supportsMessageFeatureForChannel(params, (actions) => actions.supportsCards?.(params) === true);
}
function supportsMessageFeature(cfg, check) {
    for (const plugin of listChannelPlugins()) {
        if (plugin.actions && check(plugin.actions)) {
            return true;
        }
    }
    return false;
}
function supportsMessageFeatureForChannel(params, check) {
    if (!params.channel) {
        return false;
    }
    const plugin = getChannelPlugin(params.channel);
    return plugin?.actions ? check(plugin.actions) : false;
}
export async function dispatchChannelMessageAction(ctx) {
    if (requiresTrustedRequesterSender(ctx) && !ctx.requesterSenderId?.trim()) {
        throw new Error(`Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`);
    }
    const plugin = getChannelPlugin(ctx.channel);
    if (!plugin?.actions?.handleAction) {
        return null;
    }
    if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
        return null;
    }
    return await plugin.actions.handleAction(ctx);
}
