export async function sendLineReplyChunks(params) {
    const hasQuickReplies = Boolean(params.quickReplies?.length);
    let replyTokenUsed = Boolean(params.replyTokenUsed);
    if (params.chunks.length === 0) {
        return { replyTokenUsed };
    }
    if (params.replyToken && !replyTokenUsed) {
        try {
            const replyBatch = params.chunks.slice(0, 5);
            const remaining = params.chunks.slice(replyBatch.length);
            const replyMessages = replyBatch.map((chunk) => ({
                type: "text",
                text: chunk,
            }));
            if (hasQuickReplies && remaining.length === 0 && replyMessages.length > 0) {
                const lastIndex = replyMessages.length - 1;
                replyMessages[lastIndex] = params.createTextMessageWithQuickReplies(replyBatch[lastIndex], params.quickReplies);
            }
            await params.replyMessageLine(params.replyToken, replyMessages, {
                accountId: params.accountId,
            });
            replyTokenUsed = true;
            for (let i = 0; i < remaining.length; i += 1) {
                const isLastChunk = i === remaining.length - 1;
                if (isLastChunk && hasQuickReplies) {
                    await params.pushTextMessageWithQuickReplies(params.to, remaining[i], params.quickReplies, { accountId: params.accountId });
                }
                else {
                    await params.pushMessageLine(params.to, remaining[i], {
                        accountId: params.accountId,
                    });
                }
            }
            return { replyTokenUsed };
        }
        catch (err) {
            params.onReplyError?.(err);
            replyTokenUsed = true;
        }
    }
    for (let i = 0; i < params.chunks.length; i += 1) {
        const isLastChunk = i === params.chunks.length - 1;
        if (isLastChunk && hasQuickReplies) {
            await params.pushTextMessageWithQuickReplies(params.to, params.chunks[i], params.quickReplies, { accountId: params.accountId });
        }
        else {
            await params.pushMessageLine(params.to, params.chunks[i], {
                accountId: params.accountId,
            });
        }
    }
    return { replyTokenUsed };
}
