import { sanitizeTextContent } from "../../agents/tools/chat-history-text.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
export function extractMessageText(message) {
    const role = typeof message.role === "string" ? message.role : "";
    const shouldSanitize = role === "assistant";
    const text = extractTextFromChatContent(message.content, {
        sanitizeText: shouldSanitize ? sanitizeTextContent : undefined,
    });
    return text ? { role, text } : null;
}
