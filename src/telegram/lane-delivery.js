export function createLaneDeliveryStateTracker() {
    const state = {
        delivered: false,
        skippedNonSilent: 0,
        failedNonSilent: 0,
    };
    return {
        markDelivered: () => {
            state.delivered = true;
        },
        markNonSilentSkip: () => {
            state.skippedNonSilent += 1;
        },
        markNonSilentFailure: () => {
            state.failedNonSilent += 1;
        },
        snapshot: () => ({ ...state }),
    };
}
export function createLaneTextDeliverer(params) {
    const getLanePreviewText = (lane) => lane.lastPartialText;
    const isDraftPreviewLane = (lane) => lane.stream?.previewMode?.() === "draft";
    const shouldSkipRegressivePreviewUpdate = (args) => {
        const currentPreviewText = args.currentPreviewText;
        if (currentPreviewText === undefined) {
            return false;
        }
        return (currentPreviewText.startsWith(args.text) &&
            args.text.length < currentPreviewText.length &&
            (args.skipRegressive === "always" || args.hadPreviewMessage));
    };
    const tryEditPreviewMessage = async (args) => {
        try {
            await params.editPreview({
                laneName: args.laneName,
                messageId: args.messageId,
                text: args.text,
                previewButtons: args.previewButtons,
                context: args.context,
            });
            if (args.updateLaneSnapshot) {
                args.lane.lastPartialText = args.text;
            }
            params.markDelivered();
            return true;
        }
        catch (err) {
            if (args.treatEditFailureAsDelivered) {
                params.log(`telegram: ${args.laneName} preview ${args.context} edit failed after stop-created flush; treating as delivered (${String(err)})`);
                params.markDelivered();
                return true;
            }
            params.log(`telegram: ${args.laneName} preview ${args.context} edit failed; falling back to standard send (${String(err)})`);
            return false;
        }
    };
    const tryUpdatePreviewForLane = async ({ lane, laneName, text, previewButtons, stopBeforeEdit = false, updateLaneSnapshot = false, skipRegressive, context, previewMessageId: previewMessageIdOverride, previewTextSnapshot, }) => {
        const editPreview = (messageId, treatEditFailureAsDelivered) => tryEditPreviewMessage({
            laneName,
            messageId,
            text,
            context,
            previewButtons,
            updateLaneSnapshot,
            lane,
            treatEditFailureAsDelivered,
        });
        if (!lane.stream) {
            return false;
        }
        const lanePreviewMessageId = lane.stream.messageId();
        const hadPreviewMessage = typeof previewMessageIdOverride === "number" || typeof lanePreviewMessageId === "number";
        const stopCreatesFirstPreview = stopBeforeEdit && !hadPreviewMessage && context === "final";
        if (stopCreatesFirstPreview) {
            // Final stop() can create the first visible preview message.
            // Prime pending text so the stop flush sends the final text snapshot.
            lane.stream.update(text);
            await params.stopDraftLane(lane);
            const previewMessageId = lane.stream.messageId();
            if (typeof previewMessageId !== "number") {
                return false;
            }
            const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
            const shouldSkipRegressive = shouldSkipRegressivePreviewUpdate({
                currentPreviewText,
                text,
                skipRegressive,
                hadPreviewMessage,
            });
            if (shouldSkipRegressive) {
                params.markDelivered();
                return true;
            }
            return editPreview(previewMessageId, true);
        }
        if (stopBeforeEdit) {
            await params.stopDraftLane(lane);
        }
        const previewMessageId = typeof previewMessageIdOverride === "number"
            ? previewMessageIdOverride
            : lane.stream.messageId();
        if (typeof previewMessageId !== "number") {
            return false;
        }
        const currentPreviewText = previewTextSnapshot ?? getLanePreviewText(lane);
        const shouldSkipRegressive = shouldSkipRegressivePreviewUpdate({
            currentPreviewText,
            text,
            skipRegressive,
            hadPreviewMessage,
        });
        if (shouldSkipRegressive) {
            params.markDelivered();
            return true;
        }
        return editPreview(previewMessageId, false);
    };
    const consumeArchivedAnswerPreviewForFinal = async ({ lane, text, payload, previewButtons, canEditViaPreview, }) => {
        const archivedPreview = params.archivedAnswerPreviews.shift();
        if (!archivedPreview) {
            return undefined;
        }
        if (canEditViaPreview) {
            const finalized = await tryUpdatePreviewForLane({
                lane,
                laneName: "answer",
                text,
                previewButtons,
                stopBeforeEdit: false,
                skipRegressive: "existingOnly",
                context: "final",
                previewMessageId: archivedPreview.messageId,
                previewTextSnapshot: archivedPreview.textSnapshot,
            });
            if (finalized) {
                return "preview-finalized";
            }
        }
        try {
            await params.deletePreviewMessage(archivedPreview.messageId);
        }
        catch (err) {
            params.log(`telegram: archived answer preview cleanup failed (${archivedPreview.messageId}): ${String(err)}`);
        }
        const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
        return delivered ? "sent" : "skipped";
    };
    return async ({ laneName, text, payload, infoKind, previewButtons, allowPreviewUpdateForNonFinal = false, }) => {
        const lane = params.lanes[laneName];
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        const canEditViaPreview = !hasMedia && text.length > 0 && text.length <= params.draftMaxChars && !payload.isError;
        if (infoKind === "final") {
            if (laneName === "answer") {
                const archivedResult = await consumeArchivedAnswerPreviewForFinal({
                    lane,
                    text,
                    payload,
                    previewButtons,
                    canEditViaPreview,
                });
                if (archivedResult) {
                    return archivedResult;
                }
            }
            if (canEditViaPreview && !params.finalizedPreviewByLane[laneName]) {
                await params.flushDraftLane(lane);
                if (laneName === "answer") {
                    const archivedResultAfterFlush = await consumeArchivedAnswerPreviewForFinal({
                        lane,
                        text,
                        payload,
                        previewButtons,
                        canEditViaPreview,
                    });
                    if (archivedResultAfterFlush) {
                        return archivedResultAfterFlush;
                    }
                }
                const finalized = await tryUpdatePreviewForLane({
                    lane,
                    laneName,
                    text,
                    previewButtons,
                    stopBeforeEdit: true,
                    skipRegressive: "existingOnly",
                    context: "final",
                });
                if (finalized) {
                    params.finalizedPreviewByLane[laneName] = true;
                    return "preview-finalized";
                }
            }
            else if (!hasMedia && !payload.isError && text.length > params.draftMaxChars) {
                params.log(`telegram: preview final too long for edit (${text.length} > ${params.draftMaxChars}); falling back to standard send`);
            }
            await params.stopDraftLane(lane);
            const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
            return delivered ? "sent" : "skipped";
        }
        if (allowPreviewUpdateForNonFinal && canEditViaPreview) {
            if (isDraftPreviewLane(lane)) {
                // DM draft flow has no message_id to edit; updates are sent via sendMessageDraft.
                // Only mark as updated when the draft flush actually emits an update.
                const previewRevisionBeforeFlush = lane.stream?.previewRevision?.() ?? 0;
                lane.stream?.update(text);
                await params.flushDraftLane(lane);
                const previewUpdated = (lane.stream?.previewRevision?.() ?? 0) > previewRevisionBeforeFlush;
                if (!previewUpdated) {
                    params.log(`telegram: ${laneName} draft preview update not emitted; falling back to standard send`);
                    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
                    return delivered ? "sent" : "skipped";
                }
                lane.lastPartialText = text;
                params.markDelivered();
                return "preview-updated";
            }
            const updated = await tryUpdatePreviewForLane({
                lane,
                laneName,
                text,
                previewButtons,
                stopBeforeEdit: false,
                updateLaneSnapshot: true,
                skipRegressive: "always",
                context: "update",
            });
            if (updated) {
                return "preview-updated";
            }
        }
        const delivered = await params.sendPayload(params.applyTextToPayload(payload, text));
        return delivered ? "sent" : "skipped";
    };
}
