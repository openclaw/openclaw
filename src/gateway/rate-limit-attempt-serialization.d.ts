export declare function withSerializedRateLimitAttempt<T>(params: {
    ip: string | undefined;
    scope: string | undefined;
    run: () => Promise<T>;
}): Promise<T>;
