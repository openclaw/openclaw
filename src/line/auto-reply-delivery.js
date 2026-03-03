export async function deliverLineAutoReply(params) {
    const { payload, lineData, replyToken, accountId, to, textLimit, deps } = params;
    let replyTokenUsed = params.replyTokenUsed;
    const pushLineMessages = async (messages) => {
        if (messages.length === 0) {
            return;
        }
        for (let i = 0; i < messages.length; i += 5) {
            await deps.pushMessagesLine(to, messages.slice(i, i + 5), {
                accountId,
            });
        }
    };
    const sendLineMessages = async (messages, allowReplyToken) => {
        if (messages.length === 0) {
            return;
        }
        let remaining = messages;
        if (allowReplyToken && replyToken && !replyTokenUsed) {
            const replyBatch = remaining.slice(0, 5);
            try {
                await deps.replyMessageLine(replyToken, replyBatch, {
                    accountId,
                });
            }
            catch (err) {
                deps.onReplyError?.(err);
                await pushLineMessages(replyBatch);
            }
            replyTokenUsed = true;
            remaining = remaining.slice(replyBatch.length);
        }
        if (remaining.length > 0) {
            await pushLineMessages(remaining);
        }
    };
    const richMessages = [];
    const hasQuickReplies = Boolean(lineData.quickReplies?.length);
    if (lineData.flexMessage) {
        richMessages.push(deps.createFlexMessage(lineData.flexMessage.altText.slice(0, 400), lineData.flexMessage.contents));
    }
    if (lineData.templateMessage) {
        const templateMsg = deps.buildTemplateMessageFromPayload(lineData.templateMessage);
        if (templateMsg) {
            richMessages.push(templateMsg);
        }
    }
    if (lineData.location) {
        richMessages.push(deps.createLocationMessage(lineData.location));
    }
    const processed = payload.text
        ? deps.processLineMessage(payload.text)
        : { text: "", flexMessages: [] };
    for (const flexMsg of processed.flexMessages) {
        richMessages.push(deps.createFlexMessage(flexMsg.altText.slice(0, 400), flexMsg.contents));
    }
    const chunks = processed.text ? deps.chunkMarkdownText(processed.text, textLimit) : [];
    const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const mediaMessages = mediaUrls
        .map((url) => url?.trim())
        .filter((url) => Boolean(url))
        .map((url) => deps.createImageMessage(url));
    if (chunks.length > 0) {
        const hasRichOrMedia = richMessages.length > 0 || mediaMessages.length > 0;
        if (hasQuickReplies && hasRichOrMedia) {
            try {
                await sendLineMessages([...richMessages, ...mediaMessages], false);
            }
            catch (err) {
                deps.onReplyError?.(err);
            }
        }
        const { replyTokenUsed: nextReplyTokenUsed } = await deps.sendLineReplyChunks({
            to,
            chunks,
            quickReplies: lineData.quickReplies,
            replyToken,
            replyTokenUsed,
            accountId,
            replyMessageLine: deps.replyMessageLine,
            pushMessageLine: deps.pushMessageLine,
            pushTextMessageWithQuickReplies: deps.pushTextMessageWithQuickReplies,
            createTextMessageWithQuickReplies: deps.createTextMessageWithQuickReplies,
        });
        replyTokenUsed = nextReplyTokenUsed;
        if (!hasQuickReplies || !hasRichOrMedia) {
            await sendLineMessages(richMessages, false);
            if (mediaMessages.length > 0) {
                await sendLineMessages(mediaMessages, false);
            }
        }
    }
    else {
        const combined = [...richMessages, ...mediaMessages];
        if (hasQuickReplies && combined.length > 0) {
            const quickReply = deps.createQuickReplyItems(lineData.quickReplies);
            const targetIndex = replyToken && !replyTokenUsed ? Math.min(4, combined.length - 1) : combined.length - 1;
            const target = combined[targetIndex];
            combined[targetIndex] = { ...target, quickReply };
        }
        await sendLineMessages(combined, true);
    }
    return { replyTokenUsed };
}
