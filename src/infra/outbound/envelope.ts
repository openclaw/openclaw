import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OutboundDeliveryJson } from "./format.js";
import { normalizeOutboundPayloadsForJson, type OutboundPayloadJson } from "./payloads.js";

export type OutboundResultEnvelope = {
  payloads?: OutboundPayloadJson[];
  meta?: unknown;
  delivery?: OutboundDeliveryJson;
};

type BuildEnvelopeParams = {
  payloads?: ReplyPayload[] | OutboundPayloadJson[];
  meta?: unknown;
  delivery?: OutboundDeliveryJson;
  flattenDelivery?: boolean;
};

const isOutboundPayloadJson = (
  payload: ReplyPayload | OutboundPayloadJson,
): payload is OutboundPayloadJson => "mediaUrl" in payload;

export function buildOutboundResultEnvelope(
  params: BuildEnvelopeParams,
): OutboundResultEnvelope | OutboundDeliveryJson {
  const hasPayloads = params.payloads !== undefined;
  const payloads =
    params.payloads === undefined
      ? undefined
      : params.payloads.length === 0
        ? []
        : isOutboundPayloadJson(params.payloads[0])
          ? (params.payloads as OutboundPayloadJson[])
          : normalizeOutboundPayloadsForJson(params.payloads as ReplyPayload[]);

  if (params.flattenDelivery !== false && params.delivery && !params.meta && !hasPayloads) {
    return params.delivery;
  }

  return {
    ...(hasPayloads ? { payloads } : {}),
    ...(params.meta ? { meta: params.meta } : {}),
    ...(params.delivery ? { delivery: params.delivery } : {}),
  };
}
