import { normalizeOutboundPayloadsForJson } from "./payloads.js";
const isOutboundPayloadJson = (payload) => "mediaUrl" in payload;
export function buildOutboundResultEnvelope(params) {
    const hasPayloads = params.payloads !== undefined;
    const payloads = params.payloads === undefined
        ? undefined
        : params.payloads.length === 0
            ? []
            : isOutboundPayloadJson(params.payloads[0])
                ? [...params.payloads]
                : normalizeOutboundPayloadsForJson(params.payloads);
    if (params.flattenDelivery !== false && params.delivery && !params.meta && !hasPayloads) {
        return params.delivery;
    }
    return {
        ...(hasPayloads ? { payloads } : {}),
        ...(params.meta ? { meta: params.meta } : {}),
        ...(params.delivery ? { delivery: params.delivery } : {}),
    };
}
