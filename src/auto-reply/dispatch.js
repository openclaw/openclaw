import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import { createReplyDispatcher, createReplyDispatcherWithTyping, } from "./reply/reply-dispatcher.js";
export async function withReplyDispatcher(params) {
    try {
        return await params.run();
    }
    finally {
        // Ensure dispatcher reservations are always released on every exit path.
        params.dispatcher.markComplete();
        try {
            await params.dispatcher.waitForIdle();
        }
        finally {
            await params.onSettled?.();
        }
    }
}
export async function dispatchInboundMessage(params) {
    const finalized = finalizeInboundContext(params.ctx);
    return await withReplyDispatcher({
        dispatcher: params.dispatcher,
        run: () => dispatchReplyFromConfig({
            ctx: finalized,
            cfg: params.cfg,
            dispatcher: params.dispatcher,
            replyOptions: params.replyOptions,
            replyResolver: params.replyResolver,
        }),
    });
}
export async function dispatchInboundMessageWithBufferedDispatcher(params) {
    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(params.dispatcherOptions);
    try {
        return await dispatchInboundMessage({
            ctx: params.ctx,
            cfg: params.cfg,
            dispatcher,
            replyResolver: params.replyResolver,
            replyOptions: {
                ...params.replyOptions,
                ...replyOptions,
            },
        });
    }
    finally {
        markDispatchIdle();
    }
}
export async function dispatchInboundMessageWithDispatcher(params) {
    const dispatcher = createReplyDispatcher(params.dispatcherOptions);
    return await dispatchInboundMessage({
        ctx: params.ctx,
        cfg: params.cfg,
        dispatcher,
        replyResolver: params.replyResolver,
        replyOptions: params.replyOptions,
    });
}
