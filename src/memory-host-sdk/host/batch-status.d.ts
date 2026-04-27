type BatchStatusLike = {
    id?: string;
    status?: string;
    output_file_id?: string | null;
    error_file_id?: string | null;
};
export type BatchCompletionResult = {
    outputFileId: string;
    errorFileId?: string;
};
export declare function resolveBatchCompletionFromStatus(params: {
    provider: string;
    batchId: string;
    status: BatchStatusLike;
}): BatchCompletionResult;
export declare function throwIfBatchTerminalFailure(params: {
    provider: string;
    status: BatchStatusLike;
    readError: (errorFileId: string) => Promise<string | undefined>;
}): Promise<void>;
export declare function resolveCompletedBatchResult(params: {
    provider: string;
    status: BatchStatusLike;
    wait: boolean;
    waitForBatch: () => Promise<BatchCompletionResult>;
}): Promise<BatchCompletionResult>;
export {};
