import { normalizeProviderId } from "../agents/provider-id.js";
export function normalizeMediaProviderId(id) {
    const normalized = normalizeProviderId(id);
    if (normalized === "gemini") {
        return "google";
    }
    return normalized;
}
