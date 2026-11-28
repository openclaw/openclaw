import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { isRequestBodyLimitError, readRequestBodyWithLimit } from "../infra/http-body.js";
import { sendHttpRequestRejection } from "../infra/http-request-lifecycle.js";
import { isStillPngBuffer, readImageProbeFromHeader } from "../media/image-ops.js";
import { createImageProcessorWithPixelLimits } from "../media/image-processor.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { sendJson, sendMethodNotAllowed, sendMissingScopeForbidden } from "./http-common.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { getRemoteControlUiIngressContext } from "./ingress-attribution.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { isGatewayHostBrowserOrigin, resolveAcceptedBrowserOrigin } from "./origin-check.js";
import {
  parsePwaIconRoute,
  PWA_ICON_FILES,
  PWA_ICON_MAX_BYTES,
  PWA_ICON_SIZE,
} from "./pwa-icon-contract.js";
import { createPwaIconStore, type PwaIconRasters } from "./pwa-icon-store.js";
import { readControlUiRootAsset, type ControlUiRootState } from "./server-control-ui-root.js";
import { hasGatewayDelegationClaim } from "./trusted-proxy-delegation.js";

const icons = createPwaIconStore(path.join(resolveStateDir(), "pwa-icons"));

export async function handlePwaIconHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  options: GatewayHttpRequestAuthOptions & { basePath: string; root?: ControlUiRootState },
): Promise<boolean> {
  const route = parsePwaIconRoute(pathname, options.basePath);
  if (!route) {
    return false;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (route.kind === "invalid") {
    respondNotFound(res);
    return true;
  }
  if (route.kind === "asset") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendMethodNotAllowed(res, "GET, HEAD");
      return true;
    }
    if (!(await icons.has(route.token))) {
      respondNotFound(res);
      return true;
    }
    let body: Buffer;
    if (route.manifest) {
      const root = options.root;
      const source =
        root && (root.kind === "resolved" || root.kind === "bundled")
          ? await readControlUiRootAsset(root, "manifest.webmanifest", true)
          : undefined;
      if (!source?.file.body) {
        respondNotFound(res);
        return true;
      }
      const mount = `${options.basePath}/`;
      body = Buffer.from(
        JSON.stringify({
          ...JSON.parse(source.file.body.toString("utf8")),
          id: mount,
          start_url: mount,
          scope: mount,
          icons: ([512, 192] as const).map((size) => ({
            src: "./" + PWA_ICON_FILES[size],
            type: "image/png",
            sizes: `${size}x${size}`,
            purpose: "any",
          })),
        }),
      );
    } else {
      const png = await icons.read(route.token, route.size!);
      if (!png) {
        respondNotFound(res);
        return true;
      }
      body = png;
    }
    res.setHeader("Content-Type", route.manifest ? "application/manifest+json" : "image/png");
    res.setHeader("Content-Length", body.length);
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }
  if (req.method !== "POST" && req.method !== "DELETE") {
    sendMethodNotAllowed(res, "POST, DELETE");
    return true;
  }
  const origin = resolveAcceptedBrowserOrigin({ req, cfg: options.cfg });
  const remote = getRemoteControlUiIngressContext(req);
  if (
    !origin ||
    (remote
      ? origin !== remote.publicOrigin
      : !isGatewayHostBrowserOrigin({ requestHost: req.headers.host, origin })) ||
    (req.headers["sec-fetch-site"] !== undefined &&
      req.headers["sec-fetch-site"] !== "same-origin") ||
    (!remote &&
      req.headers["sec-fetch-site"] === undefined &&
      new URL(origin).protocol !==
        ("encrypted" in req.socket && req.socket.encrypted ? "https:" : "http:")) ||
    !/^https?:\/\//iu.test(origin)
  ) {
    sendJson(res, 403, { error: "origin_not_allowed" });
    return true;
  }
  const requestAuth = await authorizeGatewayHttpRequestOrReply({ ...options, req, res }, true);
  if (!requestAuth) {
    return true;
  }
  const profileId = requestAuth.authenticatedUserProfile?.profileId;
  if (
    !profileId ||
    !requestAuth.authMethod ||
    requestAuth.authMethod === "none" ||
    requestAuth.authMethod === "bootstrap-token" ||
    hasGatewayDelegationClaim(req, options.auth.trustedProxy?.userHeader)
  ) {
    sendJson(res, 403, { error: "authenticated_profile_required" });
    return true;
  }
  const scopes =
    requestAuth.authMethod === "device-token"
      ? (requestAuth.deviceOperatorScopes ?? [])
      : resolveSharedSecretHttpOperatorScopes(req, requestAuth);
  const scope = authorizeOperatorScopesForMethod("users.background.upload", scopes);
  if (!scope.allowed) {
    sendMissingScopeForbidden(res, scope.missingScope);
    return true;
  }
  const slot = req.headers["x-openclaw-install-device"];
  if (typeof slot !== "string" || !/^[0-9a-f]{64}$/u.test(slot)) {
    sendJson(res, 400, { error: "invalid_install_device" });
    return true;
  }
  if (req.method === "DELETE") {
    const result = await icons.set(profileId, slot, null);
    if (result.status === "busy") {
      sendJson(res, 429, { error: "icon_store_busy" });
    } else {
      res.writeHead(204);
      res.end();
    }
    return true;
  }
  if (req.headers["content-type"] !== "image/png") {
    sendJson(res, 415, { error: "png_required" });
    return true;
  }
  let input: Buffer;
  try {
    const bytes = await readRequestBodyWithLimit(req, {
      maxBytes: PWA_ICON_MAX_BYTES,
      encoding: "latin1",
      destroyOnLimit: false,
    });
    input = Buffer.from(bytes, "latin1");
  } catch (error) {
    if (!isRequestBodyLimitError(error)) {
      throw error;
    }
    void sendHttpRequestRejection(req, res, error.statusCode, error.message, "text/plain");
    return true;
  }
  const probe = readImageProbeFromHeader(input);
  if (
    probe?.width !== PWA_ICON_SIZE ||
    probe.height !== PWA_ICON_SIZE ||
    !isStillPngBuffer(input)
  ) {
    sendJson(res, 400, { error: "static_512px_png_required" });
    return true;
  }
  const signal = getAsyncWorkSignal();
  let rasters: PwaIconRasters;
  try {
    const pixels = PWA_ICON_SIZE ** 2;
    const processor = createImageProcessorWithPixelLimits({
      inputPixels: pixels,
      outputPixels: pixels,
    });
    const encode = async (size: keyof PwaIconRasters) => {
      const image = await processor.encode(input, {
        format: "png",
        metadata: "strip",
        resize: { maxSide: size },
        signal,
      });
      if (image.width !== size || image.height !== size || image.data.length > PWA_ICON_MAX_BYTES) {
        throw new Error("Invalid raster");
      }
      return image.data;
    };
    rasters = { 512: await encode(512), 192: await encode(192), 180: await encode(180) };
  } catch {
    signal?.throwIfAborted();
    sendJson(res, 400, { error: "invalid_png" });
    return true;
  }
  signal?.throwIfAborted();
  const saved = await icons.set(profileId, slot, rasters);
  if (saved.status !== "ok") {
    sendJson(res, saved.status === "busy" ? 429 : 507, { error: `icon_store_${saved.status}` });
    return true;
  }
  const prefix = `${options.basePath}/pwa-icon/${saved.token}`;
  sendJson(res, 200, {
    iconUrl: `${prefix}/icon.png`,
    manifestUrl: `${prefix}/manifest.webmanifest`,
  });
  return true;
}
