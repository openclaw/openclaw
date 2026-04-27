export async function runBestEffortCleanup(params) {
    try {
        return await params.cleanup();
    }
    catch (error) {
        params.onError?.(error);
        return undefined;
    }
}
