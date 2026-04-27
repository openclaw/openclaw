import { resolveSessionThreadInfo } from "../../channels/plugins/session-conversation.js";
import { resolveLoadedSessionThreadInfo } from "../../channels/plugins/session-thread-info-loaded.js";
/**
 * Extract deliveryContext and threadId from a sessionKey.
 * Supports generic :thread: suffixes plus plugin-owned thread/session grammars.
 */
export function parseSessionThreadInfo(sessionKey) {
    return resolveSessionThreadInfo(sessionKey);
}
export function parseSessionThreadInfoFast(sessionKey) {
    return resolveLoadedSessionThreadInfo(sessionKey);
}
