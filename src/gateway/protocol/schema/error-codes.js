export const ErrorCodes = {
    NOT_LINKED: "NOT_LINKED",
    NOT_PAIRED: "NOT_PAIRED",
    AGENT_TIMEOUT: "AGENT_TIMEOUT",
    INVALID_REQUEST: "INVALID_REQUEST",
    APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
    UNAVAILABLE: "UNAVAILABLE",
};
export function errorShape(code, message, opts) {
    return {
        code,
        message,
        ...opts,
    };
}
