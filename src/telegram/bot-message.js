import { buildTelegramMessageContext, } from "./bot-message-context.js";
import { dispatchTelegramMessage } from "./bot-message-dispatch.js";
export const createTelegramMessageProcessor = (deps) => {
    const { bot, cfg, account, telegramCfg, historyLimit, groupHistories, dmPolicy, allowFrom, groupAllowFrom, ackReactionScope, logger, resolveGroupActivation, resolveGroupRequireMention, resolveTelegramGroupConfig, sendChatActionHandler, runtime, replyToMode, streamMode, textLimit, opts, } = deps;
    return async (primaryCtx, allMedia, storeAllowFrom, options, replyMedia) => {
        const context = await buildTelegramMessageContext({
            primaryCtx,
            allMedia,
            replyMedia,
            storeAllowFrom,
            options,
            bot,
            cfg,
            account,
            historyLimit,
            groupHistories,
            dmPolicy,
            allowFrom,
            groupAllowFrom,
            ackReactionScope,
            logger,
            resolveGroupActivation,
            resolveGroupRequireMention,
            resolveTelegramGroupConfig,
            sendChatActionHandler,
        });
        if (!context) {
            return;
        }
        await dispatchTelegramMessage({
            context,
            bot,
            cfg,
            runtime,
            replyToMode,
            streamMode,
            textLimit,
            telegramCfg,
            opts,
        });
    };
};
