export function parseLineWebhookBody(rawBody) {
    try {
        return JSON.parse(rawBody);
    }
    catch {
        return null;
    }
}
export function isLineWebhookVerificationRequest(body) {
    return !!body && Array.isArray(body.events) && body.events.length === 0;
}
