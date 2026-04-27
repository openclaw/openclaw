type LargePayloadBase = {
    surface: string;
    bytes?: number;
    limitBytes?: number;
    count?: number;
    channel?: string;
    pluginId?: string;
    reason?: string;
};
export declare function logLargePayload(params: LargePayloadBase & {
    action: "rejected" | "truncated" | "chunked";
}): void;
export declare function logRejectedLargePayload(params: LargePayloadBase): void;
export declare function parseContentLengthHeader(raw: string | string[] | undefined): number | undefined;
export {};
