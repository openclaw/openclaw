import { normalizeOptionalString } from "../../shared/string-coerce.js";
function stripRequiredChannelMeta(meta) {
    const { id: _ignoredId, label: _ignoredLabel, selectionLabel: _ignoredSelectionLabel, docsPath: _ignoredDocsPath, blurb: _ignoredBlurb, ...rest } = meta ?? {};
    return rest;
}
export function normalizeChannelMeta(params) {
    const next = params.meta ?? undefined;
    const existing = params.existing ?? undefined;
    const label = normalizeOptionalString(next?.label) ??
        normalizeOptionalString(existing?.label) ??
        normalizeOptionalString(next?.selectionLabel) ??
        normalizeOptionalString(existing?.selectionLabel) ??
        params.id;
    const selectionLabel = normalizeOptionalString(next?.selectionLabel) ??
        normalizeOptionalString(existing?.selectionLabel) ??
        label;
    const docsPath = normalizeOptionalString(next?.docsPath) ??
        normalizeOptionalString(existing?.docsPath) ??
        `/channels/${params.id}`;
    const blurb = normalizeOptionalString(next?.blurb) ?? normalizeOptionalString(existing?.blurb) ?? "";
    return {
        ...stripRequiredChannelMeta(existing),
        ...stripRequiredChannelMeta(next),
        id: params.id,
        label,
        selectionLabel,
        docsPath,
        blurb,
    };
}
