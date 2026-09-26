// Serves channel-owned conversation images without exposing media-store paths.
import type { IncomingMessage, ServerResponse } from "node:http";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveInboundMediaReference } from "../media/media-reference.js";
import { readMediaBuffer } from "../media/store.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { parseControlUiResourcePath } from "./control-ui-contract.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  HTTP_IMAGE_MAX_BYTES,
  resolveHttpImageRepresentation,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeControlUiSessionOwnerReadRequestOrReply } from "./http-utils.js";

const CHANNEL_AVATAR_CACHE_MAX_ENTRIES = 128;

type ChannelAvatarCacheEntry = {
  reference: string;
  image: HttpImageRepresentation;
};

const channelAvatarCache = new Map<string, ChannelAvatarCacheEntry>();
const channelAvatarLoads = new Map<
  string,
  {
    reference: string;
    pending: Map<string, Promise<HttpImageRepresentation | undefined>>;
  }
>();

const getSessionStoreModule = createLazyRuntimeModule(() => import("./session-utils-store.js"));

async function loadChannelAvatar(
  sessionKey: string,
  reference: string,
): Promise<HttpImageRepresentation | undefined> {
  let loads = channelAvatarLoads.get(sessionKey);
  if (loads) {
    loads.reference = reference;
  }
  const cached = channelAvatarCache.get(sessionKey);
  if (cached?.reference === reference) {
    channelAvatarCache.delete(sessionKey);
    channelAvatarCache.set(sessionKey, cached);
    return cached.image;
  }
  if (!loads) {
    loads = { reference, pending: new Map() };
    channelAvatarLoads.set(sessionKey, loads);
  }
  let pending = loads.pending.get(reference);
  if (!pending) {
    const sessionLoads = loads;
    pending = (async () => {
      const resolved = await resolveInboundMediaReference(reference);
      if (!resolved) {
        return undefined;
      }
      const stored = await readMediaBuffer(resolved.id, "inbound", HTTP_IMAGE_MAX_BYTES);
      const image = await resolveHttpImageRepresentation(resolved.id, stored.buffer);
      // A superseded load may reply to its callers but must not replace the current avatar.
      if (image && sessionLoads.reference === reference) {
        channelAvatarCache.delete(sessionKey);
        channelAvatarCache.set(sessionKey, { reference, image });
        pruneMapToMaxSize(channelAvatarCache, CHANNEL_AVATAR_CACHE_MAX_ENTRIES);
      }
      return image;
    })().finally(() => {
      sessionLoads.pending.delete(reference);
      if (sessionLoads.pending.size === 0) {
        channelAvatarLoads.delete(sessionKey);
      }
    });
    loads.pending.set(reference, pending);
  }
  return pending;
}

/** Serves the current channel-avatar snapshot for an owner-visible session. */
export async function handleChannelAvatarHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & {
    basePath?: string;
  },
): Promise<boolean> {
  const pathname = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
  const parsed = parseControlUiResourcePath("channelAvatar", pathname, opts.basePath);
  if (!parsed.matched) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const requestAuth = await authorizeControlUiSessionOwnerReadRequestOrReply({
    ...opts,
    req,
    res,
  });
  if (!requestAuth) {
    return true;
  }
  requestAuth.assertCurrent();
  if (!parsed.value) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  let reference: string | undefined;
  try {
    const { entry } = (await getSessionStoreModule()).loadGatewaySessionEntryReadOnly(
      parsed.value,
      { clone: false },
    );
    reference = sessionDeliveryOrigin(entry)?.avatar;
  } catch {
    // Invalid or missing session keys are ordinary route misses.
  }
  requestAuth.assertCurrent();
  if (!reference) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  let image: HttpImageRepresentation | undefined;
  try {
    image = await loadChannelAvatar(parsed.value, reference);
  } catch {
    // The media may have expired or been pruned after the session row was written.
  }
  requestAuth.assertCurrent();
  if (!image) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }
  sendHttpImageResponse({ req, res, image, filename: "channel-avatar" });
  return true;
}
