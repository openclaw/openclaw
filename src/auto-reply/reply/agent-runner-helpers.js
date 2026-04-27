import { hasOutboundReplyContent, resolveSendableOutboundReplyParts, } from "openclaw/plugin-sdk/reply-payload";
import { loadSessionStore } from "../../config/sessions.js";
import { isAudioFileName } from "../../media/mime.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { scheduleFollowupDrain } from "./queue.js";
const hasAudioMedia = (urls) => Boolean(urls?.some((url) => isAudioFileName(url)));
export const isAudioPayload = (payload) => hasAudioMedia(resolveSendableOutboundReplyParts(payload).mediaUrls);
function resolveCurrentVerboseLevel(params) {
    if (!params.sessionKey || !params.storePath) {
        return undefined;
    }
    try {
        const store = loadSessionStore(params.storePath);
        const entry = store[params.sessionKey];
        return typeof entry?.verboseLevel === "string"
            ? normalizeVerboseLevel(entry.verboseLevel)
            : undefined;
    }
    catch {
        // ignore store read failures
        return undefined;
    }
}
function createVerboseGate(params, shouldEmit) {
    // Normalize verbose values from session store/config so false/"false" still means off.
    const fallbackVerbose = params.resolvedVerboseLevel;
    return () => {
        return shouldEmit(resolveCurrentVerboseLevel(params) ?? fallbackVerbose);
    };
}
export const createShouldEmitToolResult = (params) => {
    return createVerboseGate(params, (level) => level !== "off");
};
export const createShouldEmitToolOutput = (params) => {
    return createVerboseGate(params, (level) => level === "full");
};
export const finalizeWithFollowup = (value, queueKey, runFollowupTurn) => {
    scheduleFollowupDrain(queueKey, runFollowupTurn);
    return value;
};
export const signalTypingIfNeeded = async (payloads, typingSignals) => {
    const shouldSignalTyping = payloads.some((payload) => hasOutboundReplyContent(payload, { trimText: true }));
    if (shouldSignalTyping) {
        await typingSignals.signalRunStart();
    }
};
