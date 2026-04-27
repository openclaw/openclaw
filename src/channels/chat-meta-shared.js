import { normalizeOptionalString } from "../shared/string-coerce.js";
import { listBundledChannelCatalogEntries } from "./bundled-channel-catalog-read.js";
import { CHAT_CHANNEL_ORDER } from "./ids.js";
import { buildManifestChannelMeta } from "./plugins/channel-meta.js";
const CHAT_CHANNEL_ID_SET = new Set(CHAT_CHANNEL_ORDER);
function toChatChannelMeta(params) {
    const label = normalizeOptionalString(params.channel.label);
    if (!label) {
        throw new Error(`Missing label for bundled chat channel "${params.id}"`);
    }
    return buildManifestChannelMeta({
        id: params.id,
        channel: params.channel,
        label,
        selectionLabel: normalizeOptionalString(params.channel.selectionLabel) || label,
        docsPath: normalizeOptionalString(params.channel.docsPath) || `/channels/${params.id}`,
        docsLabel: normalizeOptionalString(params.channel.docsLabel),
        blurb: normalizeOptionalString(params.channel.blurb) || "",
        detailLabel: normalizeOptionalString(params.channel.detailLabel),
        systemImage: normalizeOptionalString(params.channel.systemImage),
        arrayFieldMode: "non-empty",
        selectionDocsPrefixMode: "defined",
    });
}
export function buildChatChannelMetaById() {
    const entries = new Map();
    for (const entry of listBundledChannelCatalogEntries()) {
        const rawId = normalizeOptionalString(entry.id);
        if (!rawId || !CHAT_CHANNEL_ID_SET.has(rawId)) {
            continue;
        }
        const id = rawId;
        entries.set(id, toChatChannelMeta({
            id,
            channel: entry.channel,
        }));
    }
    return Object.freeze(Object.fromEntries(entries));
}
