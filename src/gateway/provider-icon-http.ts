import { closeSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import pLimit from "p-limit";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import { resolveConfigPath } from "../config/paths.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFile, readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { resolveUserPath } from "../infra/home-dir.js";
import { LruCache } from "../infra/lru-cache.js";
import { readRemoteMediaBuffer } from "../media/fetch.js";
import { readImageProbeFromHeader } from "../media/image-ops.js";
import { createImageProcessorWithPixelLimits } from "../media/image-processor.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { parseControlUiResourcePath } from "./control-ui-resource-routes.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  createHttpImageRepresentation,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";
import { providerIconFingerprint } from "./provider-presentation.js";

export const PROVIDER_ICON_MAX_BYTES = 2 * 1024 * 1024;
export const PROVIDER_ICON_MAX_SIDE = 4096;
const MAX_PIXELS = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const REMOTE_CACHE_MS = 5 * 60 * 1000;
const processor = createImageProcessorWithPixelLimits({
  inputPixels: MAX_PIXELS,
  outputPixels: 256 * 256,
});
const loadLimit = pLimit(4);
const remoteIcons = new LruCache<{
  expiresAt: number;
  image: Promise<HttpImageRepresentation | null>;
}>(128);
type ProviderIcon = NonNullable<ModelProviderConfig["icon"]>;

async function normalizeIcon(body: Buffer): Promise<HttpImageRepresentation | null> {
  const probe = readImageProbeFromHeader(body);
  if (
    !probe ||
    !["png", "jpeg", "gif", "webp"].includes(probe.format) ||
    probe.width < 1 ||
    probe.height < 1 ||
    probe.width > PROVIDER_ICON_MAX_SIDE ||
    probe.height > PROVIDER_ICON_MAX_SIDE ||
    probe.width > MAX_PIXELS / probe.height
  ) {
    return null;
  }
  // Re-encoding fully decodes the raster, strips metadata, and freezes animated input.
  // SVG and other active/container formats never reach the decoder or browser.
  const encoded = await processor.encode(body, {
    format: "png",
    compressionLevel: 9,
    resize: { fit: "inside", maxSide: 256, enlarge: false },
  });
  return encoded.data.byteLength <= 256 * 1024
    ? createHttpImageRepresentation(encoded.data, "image/png")
    : null;
}

async function loadIcon(icon: ProviderIcon): Promise<HttpImageRepresentation | null> {
  try {
    if (icon.source === "builtin") {
      return null;
    }
    if (icon.source === "url") {
      const loaded = await readRemoteMediaBuffer({
        url: icon.url,
        maxBytes: PROVIDER_ICON_MAX_BYTES,
        maxRedirects: 3,
        requireHttps: true,
        timeoutMs: FETCH_TIMEOUT_MS,
        responseHeaderTimeoutMs: FETCH_TIMEOUT_MS,
        readIdleTimeoutMs: FETCH_TIMEOUT_MS,
      });
      return await normalizeIcon(loaded.buffer);
    }
    // Only the exact configured file is addressable. No request-supplied paths or roots.
    const filePath = icon.path.startsWith("~")
      ? resolveUserPath(icon.path)
      : path.resolve(path.dirname(resolveConfigPath()), icon.path);
    const opened = await openRootFile({
      absolutePath: filePath,
      rootPath: path.dirname(filePath),
      boundaryLabel: "configured provider icon directory",
      maxBytes: PROVIDER_ICON_MAX_BYTES,
      rejectHardlinks: true,
    });
    if (!opened.ok) {
      return null;
    }
    try {
      return await normalizeIcon(
        await readFileDescriptorBounded(opened.fd, PROVIDER_ICON_MAX_BYTES),
      );
    } finally {
      closeSync(opened.fd);
    }
  } catch {
    // Optional artwork must never prevent catalog or picker use (including decode failures).
    return null;
  }
}

function loadProviderIcon(
  providerId: string,
  icon: ProviderIcon,
): Promise<HttpImageRepresentation | null> {
  if (icon.source !== "url") {
    return loadLimit(() => loadIcon(icon));
  }
  const key = providerId + ":" + providerIconFingerprint(icon);
  const cached = remoteIcons.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.image;
  }
  const entry = { expiresAt: Date.now() + REMOTE_CACHE_MS, image: loadLimit(() => loadIcon(icon)) };
  remoteIcons.set(key, entry);
  void entry.image.then((image) => {
    if (!image) {
      entry.expiresAt = Date.now() + 30_000;
    }
  });
  return entry.image;
}

export async function handleProviderIconHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GatewayHttpRequestAuthOptions & { config: OpenClawConfig; basePath?: string },
): Promise<boolean> {
  const url = req.url ? new URL(req.url, "http://localhost") : undefined;
  const parsed = parseControlUiResourcePath("providerIcon", url?.pathname, opts.basePath);
  if (!parsed.matched) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const auth = await authorizeControlUiReadRequestOrReply({
    ...opts,
    req,
    res,
    cfg: opts.cfg ?? opts.config,
  });
  if (!auth) {
    return true;
  }
  auth.assertCurrent();
  const providerId = parsed.value;
  const icon = providerId
    ? resolveMergedModelProviderConfig(opts.config, providerId)?.icon
    : undefined;
  if (
    !providerId ||
    !icon ||
    icon.source === "builtin" ||
    url?.searchParams.get("v") !== providerIconFingerprint(icon) ||
    loadLimit.pendingCount >= 32
  ) {
    respondNotFound(res);
    return true;
  }
  const image = await loadProviderIcon(providerId, icon);
  // Paired device tokens can be revoked while artwork loading is pending.
  await auth.revalidate();
  if (!image) {
    respondNotFound(res);
    return true;
  }
  sendHttpImageResponse({
    req,
    res,
    image,
    filename: "provider-icon",
    cacheControl: "private, no-cache",
  });
  return true;
}
