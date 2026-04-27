export const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";
export function isInvalidCronSessionTargetIdError(error) {
    return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
}
export function assertSafeCronSessionTargetId(sessionId) {
    const trimmed = sessionId.trim();
    if (!trimmed) {
        throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
    }
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
        throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
    }
    return trimmed;
}
