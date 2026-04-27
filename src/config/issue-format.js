import { sanitizeTerminalText } from "../terminal/safe-text.js";
export function normalizeConfigIssuePath(path) {
    if (typeof path !== "string") {
        return "<root>";
    }
    const trimmed = path.trim();
    return trimmed ? trimmed : "<root>";
}
export function normalizeConfigIssue(issue) {
    const hasAllowedValues = Array.isArray(issue.allowedValues) && issue.allowedValues.length > 0;
    return {
        path: normalizeConfigIssuePath(issue.path),
        message: issue.message,
        ...(hasAllowedValues ? { allowedValues: issue.allowedValues } : {}),
        ...(hasAllowedValues &&
            typeof issue.allowedValuesHiddenCount === "number" &&
            issue.allowedValuesHiddenCount > 0
            ? { allowedValuesHiddenCount: issue.allowedValuesHiddenCount }
            : {}),
    };
}
export function normalizeConfigIssues(issues) {
    return issues.map((issue) => normalizeConfigIssue(issue));
}
function resolveIssuePathForLine(path, opts) {
    if (opts?.normalizeRoot) {
        return normalizeConfigIssuePath(path);
    }
    return typeof path === "string" ? path : "";
}
export function formatConfigIssueLine(issue, marker = "-", opts) {
    const prefix = marker ? `${marker} ` : "";
    const path = sanitizeTerminalText(resolveIssuePathForLine(issue.path, opts));
    const message = sanitizeTerminalText(issue.message);
    return `${prefix}${path}: ${message}`;
}
export function formatConfigIssueLines(issues, marker = "-", opts) {
    return issues.map((issue) => formatConfigIssueLine(issue, marker, opts));
}
