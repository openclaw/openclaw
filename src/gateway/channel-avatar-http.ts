// Serves channel-owned conversation images without exposing media-store paths.
import type { IncomingMessage, ServerResponse } from "node:http";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { getRuntimeConfig } from "../config/io.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { LruCache } from "../infra/lru-cache.js";
import { resolveInboundMediaReference } from "../media/media-reference.js";
import { readMediaBuffer } from "../media/store.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { sessionDeliveryOrigin } from "../utils/delivery-context.read.js";
import { matchesChannelAvatarSender } from "./channel-avatar-reference.js";
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

const channelAvatarCache = new LruCache<ChannelAvatarCacheEntry>(CHANNEL_AVATAR_CACHE_MAX_ENTRIES);
const channelAvatarLoads = new Map<string, Promise<HttpImageRepresentation | undefined>>();

const getSessionStoreModule = createLazyRuntimeModule(
  () => import("./session-utils-store-worker.js"),
);

async function loadChannelAvatar(
  sessionKey: string,
  reference: string,
): Promise<HttpImageRepresentation | undefined> {
  const cached = channelAvatarCache.get(sessionKey);
  if (cached?.reference === reference) {
    return cached.image;
  }
  const loadKey = JSON.stringify([sessionKey, reference]);
  let pending = channelAvatarLoads.get(loadKey);
  if (!pending) {
    pending = (async () => {
      const resolved = await resolveInboundMediaReference(reference);
      if (!resolved) {
        return undefined;
      }
      const stored = await readMediaBuffer(resolved.id, "inbound", HTTP_IMAGE_MAX_BYTES);
      const image = await resolveHttpImageRepresentation(resolved.id, stored.buffer);
      // A late older load can cause one cache miss, never return bytes for a different reference.
      if (image) {
        channelAvatarCache.set(sessionKey, { reference, image });
      }
      return image;
    })().finally(() => {
      channelAvatarLoads.delete(loadKey);
    });
    channelAvatarLoads.set(loadKey, pending);
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
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;
  const parsed = parseControlUiResourcePath("channelAvatar", pathname, opts.basePath);
  if (!parsed.matched) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const requestedKey = parsed.value;
  const sessionKey = requestedKey
    ? normalizeSessionKeyPreservingOpaquePeerIds(requestedKey)
    : undefined;
  let selected: Result<ReturnType<typeof captureSessionEntryMetadataRead>, unknown>;
  try {
    selected = ok(
      sessionKey ? captureSessionEntryMetadataRead({ sessionKey }, () => {}) : undefined,
    );
  } catch (error) {
    selected = err(error);
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
  if (!selected.ok) {
    throw selected.error;
  }
  const source = selected.value;
  if (!requestedKey || !sessionKey) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  const serve = async (reference: string | undefined, assertCurrent: () => void) => {
    assertCurrent();
    if (!reference) {
      res.setHeader("cache-control", "no-store");
      respondNotFound(res);
      return true;
    }

    let image: HttpImageRepresentation | undefined;
    try {
      image = await loadChannelAvatar(sessionKey, reference);
    } catch {
      // The media may have expired or been pruned after the session row was written.
    }
    assertCurrent();
    if (!image) {
      res.setHeader("cache-control", "no-store");
      respondNotFound(res);
      return true;
    }
    sendHttpImageResponse({ req, res, image, filename: "channel-avatar" });
    return true;
  };
  if (source) {
    const entry = source.readCurrent();
    const origin = sessionDeliveryOrigin(entry);
    const reference = origin?.avatar;
    const assertCurrent = () => {
      requestAuth.assertCurrent();
      const current = source.readCurrent();
      if (
        current?.sessionId !== entry?.sessionId ||
        current?.lifecycleRevision !== entry?.lifecycleRevision ||
        sessionDeliveryOrigin(current)?.avatar !== reference
      ) {
        throw new Error("Channel avatar session authority changed");
      }
    };
    return serve(
      matchesChannelAvatarSender(requestUrl.searchParams, origin) ? reference : undefined,
      assertCurrent,
    );
  }
  let reference: string | undefined;
  try {
    const { entry } = await (
      await getSessionStoreModule()
    ).loadGatewaySessionEntryReadOnlyInWorker({
      cfg: getRuntimeConfig(),
      key: requestedKey,
      assertActive: requestAuth.assertCurrent,
    });
    const origin = sessionDeliveryOrigin(entry);
    reference = matchesChannelAvatarSender(requestUrl.searchParams, origin)
      ? origin?.avatar
      : undefined;
  } catch {
    // Invalid or missing session keys are ordinary route misses.
  }
  return serve(reference, requestAuth.assertCurrent);
}
