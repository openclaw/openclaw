import { logVerbose, shouldLogVerbose } from "../globals.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
let deliverRuntimePromise = null;
function loadDeliverRuntime() {
    deliverRuntimePromise ??= import("../infra/outbound/deliver-runtime.js");
    return deliverRuntimePromise;
}
export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';
function formatEchoTranscript(transcript, format) {
    return format.replace("{transcript}", transcript);
}
/**
 * Sends the transcript echo back to the originating chat.
 * Best-effort: logs on failure, never throws.
 */
export async function sendTranscriptEcho(params) {
    const { ctx, cfg, transcript } = params;
    const channel = ctx.Provider ?? ctx.Surface ?? "";
    const to = ctx.OriginatingTo ?? ctx.From ?? "";
    if (!channel || !to) {
        if (shouldLogVerbose()) {
            logVerbose("media: echo-transcript skipped (no channel/to resolved from ctx)");
        }
        return;
    }
    const normalizedChannel = normalizeLowercaseStringOrEmpty(channel);
    if (!isDeliverableMessageChannel(normalizedChannel)) {
        if (shouldLogVerbose()) {
            logVerbose(`media: echo-transcript skipped (channel "${normalizedChannel}" is not deliverable)`);
        }
        return;
    }
    const text = formatEchoTranscript(transcript, params.format ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT);
    try {
        const { deliverOutboundPayloads } = await loadDeliverRuntime();
        await deliverOutboundPayloads({
            cfg,
            channel: normalizedChannel,
            to,
            accountId: ctx.AccountId ?? undefined,
            threadId: ctx.MessageThreadId ?? undefined,
            payloads: [{ text }],
            bestEffort: true,
        });
        if (shouldLogVerbose()) {
            logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
        }
    }
    catch (err) {
        logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
    }
}
