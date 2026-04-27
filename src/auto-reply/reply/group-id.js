import { getLoadedChannelPluginById } from "../../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { extractSimpleExplicitGroupId } from "./group-id-simple.js";
export { extractSimpleExplicitGroupId };
export function extractExplicitGroupId(raw) {
    const trimmed = normalizeOptionalString(raw) ?? "";
    if (!trimmed) {
        return undefined;
    }
    const simple = extractSimpleExplicitGroupId(trimmed);
    if (simple) {
        return simple;
    }
    const firstPart = trimmed.split(":").find(Boolean);
    const channelId = normalizeAnyChannelId(firstPart ?? "") ?? normalizeOptionalLowercaseString(firstPart);
    const messaging = channelId
        ? getLoadedChannelPluginById(channelId)?.messaging
        : undefined;
    const parsed = messaging?.parseExplicitTarget?.({ raw: trimmed }) ?? null;
    if (parsed && parsed.chatType && parsed.chatType !== "direct") {
        return parsed.to.replace(/:topic:.*$/, "") || undefined;
    }
    return undefined;
}
