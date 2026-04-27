import { resolveChannelExposure } from "./exposure.js";
export function buildManifestChannelMeta(params) {
    const hasArrayField = (value) => params.arrayFieldMode === "defined" ? value !== undefined : Boolean(value?.length);
    const hasSelectionDocsPrefix = params.selectionDocsPrefixMode === "defined"
        ? params.channel.selectionDocsPrefix !== undefined
        : Boolean(params.channel.selectionDocsPrefix);
    return {
        id: params.id,
        label: params.label,
        selectionLabel: params.selectionLabel,
        docsPath: params.docsPath,
        docsLabel: params.docsLabel,
        blurb: params.blurb,
        ...(hasArrayField(params.channel.aliases) ? { aliases: params.channel.aliases } : {}),
        ...(params.channel.order !== undefined ? { order: params.channel.order } : {}),
        ...(hasSelectionDocsPrefix ? { selectionDocsPrefix: params.channel.selectionDocsPrefix } : {}),
        ...(params.channel.selectionDocsOmitLabel !== undefined
            ? { selectionDocsOmitLabel: params.channel.selectionDocsOmitLabel }
            : {}),
        ...(hasArrayField(params.channel.selectionExtras)
            ? { selectionExtras: params.channel.selectionExtras }
            : {}),
        ...(params.detailLabel ? { detailLabel: params.detailLabel } : {}),
        ...(params.systemImage ? { systemImage: params.systemImage } : {}),
        ...(params.channel.markdownCapable !== undefined
            ? { markdownCapable: params.channel.markdownCapable }
            : {}),
        exposure: resolveChannelExposure(params.channel),
        ...(params.channel.quickstartAllowFrom !== undefined
            ? { quickstartAllowFrom: params.channel.quickstartAllowFrom }
            : {}),
        ...(params.channel.forceAccountBinding !== undefined
            ? { forceAccountBinding: params.channel.forceAccountBinding }
            : {}),
        ...(params.channel.preferSessionLookupForAnnounceTarget !== undefined
            ? {
                preferSessionLookupForAnnounceTarget: params.channel.preferSessionLookupForAnnounceTarget,
            }
            : {}),
        ...(hasArrayField(params.channel.preferOver) ? { preferOver: params.channel.preferOver } : {}),
    };
}
