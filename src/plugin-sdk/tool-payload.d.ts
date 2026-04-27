export type ToolPayloadCarrier = {
    details?: unknown;
    content?: unknown;
};
/**
 * Extract the most useful payload from tool result-like objects shared across
 * outbound core flows and bundled plugin helpers.
 */
export declare function extractToolPayload(result: ToolPayloadCarrier | null | undefined): unknown;
