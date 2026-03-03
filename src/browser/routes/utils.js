import { parseBooleanValue } from "../../utils/boolean.js";
/**
 * Extract profile name from query string or body and get profile context.
 * Query string takes precedence over body for consistency with GET routes.
 */
export function getProfileContext(req, ctx) {
    let profileName;
    // Check query string first (works for GET and POST)
    if (typeof req.query.profile === "string") {
        profileName = req.query.profile.trim() || undefined;
    }
    // Fall back to body for POST requests
    if (!profileName && req.body && typeof req.body === "object") {
        const body = req.body;
        if (typeof body.profile === "string") {
            profileName = body.profile.trim() || undefined;
        }
    }
    try {
        return ctx.forProfile(profileName);
    }
    catch (err) {
        return { error: String(err), status: 404 };
    }
}
export function jsonError(res, status, message) {
    res.status(status).json({ error: message });
}
export function toStringOrEmpty(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value).trim();
    }
    return "";
}
export function toNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}
export function toBoolean(value) {
    return parseBooleanValue(value, {
        truthy: ["true", "1", "yes"],
        falsy: ["false", "0", "no"],
    });
}
export function toStringArray(value) {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const strings = value.map((v) => toStringOrEmpty(v)).filter(Boolean);
    return strings.length ? strings : undefined;
}
