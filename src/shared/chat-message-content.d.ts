export declare function extractFirstTextBlock(message: unknown): string | undefined;
export type AssistantPhase = "commentary" | "final_answer";
export declare function normalizeAssistantPhase(value: unknown): AssistantPhase | undefined;
export declare function parseAssistantTextSignature(value: unknown): {
    id?: string;
    phase?: AssistantPhase;
} | null;
export declare function encodeAssistantTextSignature(params: {
    id: string;
    phase?: AssistantPhase;
}): string;
export declare function resolveAssistantMessagePhase(message: unknown): AssistantPhase | undefined;
export declare function extractAssistantTextForPhase(message: unknown, options?: {
    phase?: AssistantPhase;
    sanitizeText?: (text: string) => string;
    joinWith?: string;
}): string | undefined;
export declare function extractAssistantVisibleText(message: unknown): string | undefined;
