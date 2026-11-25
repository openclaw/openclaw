import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { HostReadMediaTypeError } from "../../media/local-media-access.js";
import { loadWebMedia } from "../../media/web-media.js";
import type { InternalDeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
} from "./deliver-payload.js";

/** Validate all host-read sources before a live-only batch starts sending. */
export async function preflightUnqueuedOutboundMedia(
  params: InternalDeliverOutboundPayloadsParams,
): Promise<void> {
  const sources = collectPayloadMediaSources(params.payloads);
  const mediaAccess = resolveOutboundMediaAccessForSend(params, sources);
  if (!mediaAccess.readFile) {
    return;
  }
  const options = buildOutboundMediaLoadOptions({
    mediaAccess,
    maxBytes: resolveOutboundMediaMaxBytes({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
    }),
  });
  for (const source of new Set(sources)) {
    if (isPassThroughRemoteMediaSource(source) || /^data:/i.test(source)) {
      continue;
    }
    try {
      await loadWebMedia(source, options);
    } catch (error) {
      if (error instanceof HostReadMediaTypeError) {
        throw error;
      }
      // Other failures still belong to the normal live-send path.
    }
  }
}
