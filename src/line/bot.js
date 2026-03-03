import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { createNonExitingRuntime } from "../runtime.js";
import { resolveLineAccount } from "./accounts.js";
import { handleLineWebhookEvents } from "./bot-handlers.js";
import { startLineWebhook } from "./webhook.js";
export function createLineBot(opts) {
    const runtime = opts.runtime ?? createNonExitingRuntime();
    const cfg = opts.config ?? loadConfig();
    const account = resolveLineAccount({
        cfg,
        accountId: opts.accountId,
    });
    const mediaMaxBytes = (opts.mediaMaxMb ?? account.config.mediaMaxMb ?? 10) * 1024 * 1024;
    const processMessage = opts.onMessage ??
        (async () => {
            logVerbose("line: no message handler configured");
        });
    const handleWebhook = async (body) => {
        if (!body.events || body.events.length === 0) {
            return;
        }
        await handleLineWebhookEvents(body.events, {
            cfg,
            account,
            runtime,
            mediaMaxBytes,
            processMessage,
        });
    };
    return {
        handleWebhook,
        account,
    };
}
export function createLineWebhookCallback(bot, channelSecret, path = "/line/webhook") {
    const { handler } = startLineWebhook({
        channelSecret,
        onEvents: bot.handleWebhook,
        path,
    });
    return { path, handler };
}
