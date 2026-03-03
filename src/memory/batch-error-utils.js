function getResponseErrorMessage(line) {
    const body = line?.response?.body;
    if (typeof body === "string") {
        return body || undefined;
    }
    if (!body || typeof body !== "object") {
        return undefined;
    }
    return typeof body.error?.message === "string" ? body.error.message : undefined;
}
export function extractBatchErrorMessage(lines) {
    const first = lines.find((line) => line.error?.message || getResponseErrorMessage(line));
    return first?.error?.message ?? getResponseErrorMessage(first);
}
export function formatUnavailableBatchError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return message ? `error file unavailable: ${message}` : undefined;
}
