import { SessionManager } from "@mariozechner/pi-coding-agent";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
function resolveInjectedAssistantContent(params) {
    const labelPrefix = params.label ? `[${params.label}]\n\n` : "";
    if (params.content && params.content.length > 0) {
        if (!labelPrefix) {
            return params.content;
        }
        const first = params.content[0];
        if (first &&
            typeof first === "object" &&
            first.type === "text" &&
            typeof first.text === "string") {
            return [{ ...first, text: `${labelPrefix}${first.text}` }, ...params.content.slice(1)];
        }
        return [{ type: "text", text: labelPrefix.trim() }, ...params.content];
    }
    return [{ type: "text", text: `${labelPrefix}${params.message}` }];
}
export function appendInjectedAssistantMessageToTranscript(params) {
    const now = params.now ?? Date.now();
    const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
        },
    };
    const resolvedContent = resolveInjectedAssistantContent({
        message: params.message,
        label: params.label,
        content: params.content,
    });
    const messageBody = {
        role: "assistant",
        // Gateway-injected assistant messages can include non-model content blocks (e.g. embedded TTS audio).
        content: resolvedContent,
        timestamp: now,
        // Pi stopReason is a strict enum; this is not model output, but we still store it as a
        // normal assistant message so it participates in the session parentId chain.
        stopReason: "stop",
        usage,
        // Make these explicit so downstream tooling never treats this as model output.
        api: "openai-responses",
        provider: "openclaw",
        model: "gateway-injected",
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
        ...(params.abortMeta
            ? {
                openclawAbort: {
                    aborted: true,
                    origin: params.abortMeta.origin,
                    runId: params.abortMeta.runId,
                },
            }
            : {}),
    };
    try {
        // IMPORTANT: Use SessionManager so the entry is attached to the current leaf via parentId.
        // Raw jsonl appends break the parent chain and can hide compaction summaries from context.
        const sessionManager = SessionManager.open(params.transcriptPath);
        const messageId = sessionManager.appendMessage(messageBody);
        emitSessionTranscriptUpdate({
            sessionFile: params.transcriptPath,
            message: messageBody,
            messageId,
        });
        return { ok: true, messageId, message: messageBody };
    }
    catch (err) {
        return { ok: false, error: formatErrorMessage(err) };
    }
}
