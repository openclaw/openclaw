import { loadConfig } from "../config/config.js";
import { resolveMarkdownTableMode } from "../config/markdown-tables.js";
import { mediaKindFromMime } from "../media/constants.js";
import { resolveOutboundAttachmentFromUrl } from "../media/outbound-attachment.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { markdownToSignalText } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";
function parseTarget(raw) {
    let value = raw.trim();
    if (!value) {
        throw new Error("Signal recipient is required");
    }
    const lower = value.toLowerCase();
    if (lower.startsWith("signal:")) {
        value = value.slice("signal:".length).trim();
    }
    const normalized = value.toLowerCase();
    if (normalized.startsWith("group:")) {
        return { type: "group", groupId: value.slice("group:".length).trim() };
    }
    if (normalized.startsWith("username:")) {
        return {
            type: "username",
            username: value.slice("username:".length).trim(),
        };
    }
    if (normalized.startsWith("u:")) {
        return { type: "username", username: value.trim() };
    }
    return { type: "recipient", recipient: value };
}
function buildTargetParams(target, allow) {
    if (target.type === "recipient") {
        if (!allow.recipient) {
            return null;
        }
        return { recipient: [target.recipient] };
    }
    if (target.type === "group") {
        if (!allow.group) {
            return null;
        }
        return { groupId: target.groupId };
    }
    if (target.type === "username") {
        if (!allow.username) {
            return null;
        }
        return { username: [target.username] };
    }
    return null;
}
export async function sendMessageSignal(to, text, opts = {}) {
    const cfg = loadConfig();
    const accountInfo = resolveSignalAccount({
        cfg,
        accountId: opts.accountId,
    });
    const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
    const target = parseTarget(to);
    let message = text ?? "";
    let messageFromPlaceholder = false;
    let textStyles = [];
    const textMode = opts.textMode ?? "markdown";
    const maxBytes = (() => {
        if (typeof opts.maxBytes === "number") {
            return opts.maxBytes;
        }
        if (typeof accountInfo.config.mediaMaxMb === "number") {
            return accountInfo.config.mediaMaxMb * 1024 * 1024;
        }
        if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
            return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
        }
        return 8 * 1024 * 1024;
    })();
    let attachments;
    if (opts.mediaUrl?.trim()) {
        const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
            localRoots: opts.mediaLocalRoots,
        });
        attachments = [resolved.path];
        const kind = mediaKindFromMime(resolved.contentType ?? undefined);
        if (!message && kind) {
            // Avoid sending an empty body when only attachments exist.
            message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
            messageFromPlaceholder = true;
        }
    }
    if (message.trim() && !messageFromPlaceholder) {
        if (textMode === "plain") {
            textStyles = opts.textStyles ?? [];
        }
        else {
            const tableMode = resolveMarkdownTableMode({
                cfg,
                channel: "signal",
                accountId: accountInfo.accountId,
            });
            const formatted = markdownToSignalText(message, { tableMode });
            message = formatted.text;
            textStyles = formatted.styles;
        }
    }
    if (!message.trim() && (!attachments || attachments.length === 0)) {
        throw new Error("Signal send requires text or media");
    }
    const params = { message };
    if (textStyles.length > 0) {
        params["text-style"] = textStyles.map((style) => `${style.start}:${style.length}:${style.style}`);
    }
    if (account) {
        params.account = account;
    }
    if (attachments && attachments.length > 0) {
        params.attachments = attachments;
    }
    const targetParams = buildTargetParams(target, {
        recipient: true,
        group: true,
        username: true,
    });
    if (!targetParams) {
        throw new Error("Signal recipient is required");
    }
    Object.assign(params, targetParams);
    const result = await signalRpcRequest("send", params, {
        baseUrl,
        timeoutMs: opts.timeoutMs,
    });
    const timestamp = result?.timestamp;
    return {
        messageId: timestamp ? String(timestamp) : "unknown",
        timestamp,
    };
}
export async function sendTypingSignal(to, opts = {}) {
    const { baseUrl, account } = resolveSignalRpcContext(opts);
    const targetParams = buildTargetParams(parseTarget(to), {
        recipient: true,
        group: true,
    });
    if (!targetParams) {
        return false;
    }
    const params = { ...targetParams };
    if (account) {
        params.account = account;
    }
    if (opts.stop) {
        params.stop = true;
    }
    await signalRpcRequest("sendTyping", params, {
        baseUrl,
        timeoutMs: opts.timeoutMs,
    });
    return true;
}
export async function sendReadReceiptSignal(to, targetTimestamp, opts = {}) {
    if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
        return false;
    }
    const { baseUrl, account } = resolveSignalRpcContext(opts);
    const targetParams = buildTargetParams(parseTarget(to), {
        recipient: true,
    });
    if (!targetParams) {
        return false;
    }
    const params = {
        ...targetParams,
        targetTimestamp,
        type: opts.type ?? "read",
    };
    if (account) {
        params.account = account;
    }
    await signalRpcRequest("sendReceipt", params, {
        baseUrl,
        timeoutMs: opts.timeoutMs,
    });
    return true;
}
