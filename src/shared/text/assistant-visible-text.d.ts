export declare function stripToolCallXmlTags(text: string): string;
/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export declare function stripMinimaxToolCallXml(text: string): string;
/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export declare function stripDowngradedToolCallText(text: string): string;
export type AssistantVisibleTextSanitizerProfile = "delivery" | "history" | "internal-scaffolding";
export declare function sanitizeAssistantVisibleTextWithProfile(text: string, profile?: AssistantVisibleTextSanitizerProfile): string;
export declare function stripAssistantInternalScaffolding(text: string): string;
/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
export declare function sanitizeAssistantVisibleText(text: string): string;
/**
 * Backwards-compatible trim wrapper.
 * Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
 */
export declare function sanitizeAssistantVisibleTextWithOptions(text: string, options?: {
    trim?: "none" | "both";
}): string;
