import { createDraftStreamLoop } from "./draft-stream-loop.js";
export function createFinalizableDraftStreamControls(params) {
    const loop = createDraftStreamLoop({
        throttleMs: params.throttleMs,
        isStopped: params.isStopped,
        sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    });
    const update = (text) => {
        if (params.isStopped() || params.isFinal()) {
            return;
        }
        loop.update(text);
    };
    const stop = async () => {
        params.markFinal();
        await loop.flush();
    };
    const stopForClear = async () => {
        params.markStopped();
        loop.stop();
        await loop.waitForInFlight();
    };
    return {
        loop,
        update,
        stop,
        stopForClear,
    };
}
export function createFinalizableDraftStreamControlsForState(params) {
    return createFinalizableDraftStreamControls({
        throttleMs: params.throttleMs,
        isStopped: () => params.state.stopped,
        isFinal: () => params.state.final,
        markStopped: () => {
            params.state.stopped = true;
        },
        markFinal: () => {
            params.state.final = true;
        },
        sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    });
}
export async function takeMessageIdAfterStop(params) {
    await params.stopForClear();
    const messageId = params.readMessageId();
    params.clearMessageId();
    return messageId;
}
export async function clearFinalizableDraftMessage(params) {
    const messageId = await takeMessageIdAfterStop({
        stopForClear: params.stopForClear,
        readMessageId: params.readMessageId,
        clearMessageId: params.clearMessageId,
    });
    if (!params.isValidMessageId(messageId)) {
        return;
    }
    try {
        await params.deleteMessage(messageId);
        params.onDeleteSuccess?.(messageId);
    }
    catch (err) {
        params.warn?.(`${params.warnPrefix}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export function createFinalizableDraftLifecycle(params) {
    const controls = createFinalizableDraftStreamControlsForState({
        throttleMs: params.throttleMs,
        state: params.state,
        sendOrEditStreamMessage: params.sendOrEditStreamMessage,
    });
    const clear = async () => {
        await clearFinalizableDraftMessage({
            stopForClear: controls.stopForClear,
            readMessageId: params.readMessageId,
            clearMessageId: params.clearMessageId,
            isValidMessageId: params.isValidMessageId,
            deleteMessage: params.deleteMessage,
            onDeleteSuccess: params.onDeleteSuccess,
            warn: params.warn,
            warnPrefix: params.warnPrefix,
        });
    };
    return {
        ...controls,
        clear,
    };
}
