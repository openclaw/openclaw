export declare function runBestEffortCleanup<T>(params: {
    cleanup: () => Promise<T>;
    onError?: (error: unknown) => void;
}): Promise<T | undefined>;
