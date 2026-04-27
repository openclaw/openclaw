export declare function readResponseWithLimit(res: Response, maxBytes: number, opts?: {
    onOverflow?: (params: {
        size: number;
        maxBytes: number;
        res: Response;
    }) => Error;
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: {
        chunkTimeoutMs: number;
    }) => Error;
}): Promise<Buffer>;
export declare function readResponseTextSnippet(res: Response, opts?: {
    maxBytes?: number;
    maxChars?: number;
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: {
        chunkTimeoutMs: number;
    }) => Error;
}): Promise<string | undefined>;
