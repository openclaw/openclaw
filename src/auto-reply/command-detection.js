import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../shared/string-coerce.js";
import { listChatCommands, listChatCommandsForConfig } from "./commands-registry-list.js";
import { normalizeCommandBody } from "./commands-registry-normalize.js";
import { isAbortTrigger } from "./reply/abort-primitives.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";
export function hasControlCommand(text, cfg, options) {
    if (!text) {
        return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    const stripped = stripInboundMetadata(trimmed);
    if (!stripped) {
        return false;
    }
    const normalizedBody = normalizeCommandBody(stripped, options);
    if (!normalizedBody) {
        return false;
    }
    const lowered = normalizeLowercaseStringOrEmpty(normalizedBody);
    const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
    for (const command of commands) {
        for (const alias of command.textAliases) {
            const normalized = normalizeOptionalLowercaseString(alias);
            if (!normalized) {
                continue;
            }
            if (lowered === normalized) {
                return true;
            }
            if (command.acceptsArgs && lowered.startsWith(normalized)) {
                const nextChar = normalizedBody.charAt(normalized.length);
                if (nextChar && /\s/.test(nextChar)) {
                    return true;
                }
            }
        }
    }
    return false;
}
export function isControlCommandMessage(text, cfg, options) {
    if (!text) {
        return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    if (hasControlCommand(trimmed, cfg, options)) {
        return true;
    }
    const stripped = stripInboundMetadata(trimmed);
    const normalized = normalizeOptionalLowercaseString(normalizeCommandBody(stripped, options)) ?? "";
    return isAbortTrigger(normalized);
}
/**
 * Coarse detection for inline directives/shortcuts (e.g. "hey /status") so channel monitors
 * can decide whether to compute CommandAuthorized for a message.
 *
 * This intentionally errs on the side of false positives; CommandAuthorized only gates
 * command/directive execution, not normal chat replies.
 */
export function hasInlineCommandTokens(text) {
    const body = text ?? "";
    if (!body.trim()) {
        return false;
    }
    return /(?:^|\s)[/!][a-z]/i.test(body);
}
export function shouldComputeCommandAuthorized(text, cfg, options) {
    return isControlCommandMessage(text, cfg, options) || hasInlineCommandTokens(text);
}
