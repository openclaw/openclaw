import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import {
  buildControlUiPublicSessionSharePath,
  parseControlUiPublicSessionShareUrl,
} from "@openclaw/session-url-contract/public-share";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import { isSecurePublicSessionIngress } from "./control-ui-public-session-ingress.js";
import { PUBLIC_SESSION_CONTENT_SECURITY_POLICY } from "./control-ui-public-session-render.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export function isControlUiPublicSessionPath(pathname: string, basePath: string): boolean {
  return pathname === `${basePath}/share/session`;
}

export async function serveControlUiPublicSession(params: {
  req: IncomingMessage;
  res: ServerResponse;
  basePath: string;
  config: OpenClawConfig;
  ingress: GatewayAttributedIngress;
  projection?: SessionRowProjection;
  gate: ControlUiPublicSessionRequestGate;
}): Promise<true> {
  const { req, res, basePath, config: cfg, projection, gate: requestGate } = params;
  const url = req.url ? new URL(req.url, "http://localhost") : undefined;
  if (!url) {
    respondNotFound(res);
    return true;
  }
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  const secureIngress = isSecurePublicSessionIngress(req, params.ingress, publicOrigin);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", PUBLIC_SESSION_CONTENT_SECURITY_POLICY);
  const unavailable = (status: 404 | 429 | 503, retryAfterSeconds = 1) => {
    const body =
      status === 404
        ? "This public session is unavailable."
        : status === 429
          ? "Too many public session requests. Please retry later."
          : "This public session is temporarily unavailable. Please retry.";
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    if (status === 429 || status === 503) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }
    res.end(req.method === "HEAD" ? undefined : body);
    return true as const;
  };
  const publicShare = parseControlUiPublicSessionShareUrl(url, basePath);
  const origin = resolveControlUiShareOrigin(req, publicOrigin);
  const offsetText = url.searchParams.get("offset") ?? "0";
  const offset = Number(offsetText);
  if (
    (req.method !== "GET" && req.method !== "HEAD") ||
    !publicShare ||
    !origin ||
    !cfg ||
    url.searchParams.getAll("offset").length > 1 ||
    !/^(?:0|[1-9][0-9]{0,9})$/u.test(offsetText)
  ) {
    return unavailable(404);
  }
  if (!secureIngress) {
    return unavailable(404);
  }
  // A truthful HEAD would still need authorization, transcript I/O, redaction, and
  // rendering to compute the GET status and length. Refuse it instead of doing that work.
  if (req.method === "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Length", "0");
    res.end();
    return true;
  }
  const clientAdmission = requestGate.admitClient(params.ingress.rateLimit.subject.key);
  if (clientAdmission.kind === "rate-limited") {
    return unavailable(429, clientAdmission.retryAfterSeconds);
  }
  try {
    const { resolvePublicSessionShareToken } = await import("./control-ui-public-session-token.js");
    const locator = await resolvePublicSessionShareToken(publicShare.token);
    if (!locator) {
      return unavailable(404);
    }
    if (!projection) {
      return unavailable(503);
    }
    const { servePublicSessionRepresentation } =
      await import("./control-ui-public-session-response.js");
    const latestUrl = buildControlUiPublicSessionSharePath({ basePath, token: publicShare.token });
    const canonicalUrl =
      publicOrigin || req.socket instanceof TLSSocket ? `${origin}${latestUrl}` : undefined;
    return await servePublicSessionRepresentation({
      ...params,
      locator,
      projection,
      offset,
      requestKey: JSON.stringify([
        createHash("sha256").update(publicShare.token).digest("base64url"),
        offset,
        origin,
      ]),
      document: {
        latestUrl,
        canonicalUrl,
        assetBasePath: basePath,
        cardUrl: `${origin}${basePath}/share/card.png`,
      },
      olderUrl: (olderOffset) => `${latestUrl}&offset=${olderOffset}`,
      unavailable,
    });
  } catch {
    return unavailable(503);
  }
}
