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
import {
  createControlUiPublicSessionRequestGate,
  type ControlUiPublicSessionRequestGate,
} from "./control-ui-public-session-admission.js";
import { isSecurePublicSessionIngress } from "./control-ui-public-session-ingress.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export function isControlUiPublicSessionPath(pathname: string, basePath: string): boolean {
  return pathname === `${basePath}/share/session`;
}

async function serveControlUiPublicSession(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  basePath: string,
  cfg: OpenClawConfig | undefined,
  requestGate: ControlUiPublicSessionRequestGate,
  clientKey: string,
  secureIngress: boolean,
  publicOrigin?: string,
  projection?: SessionRowProjection,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
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
    unavailable(404);
    return;
  }
  if (!secureIngress) {
    unavailable(404);
    return;
  }
  // A truthful HEAD would still need authorization, transcript I/O, redaction, and
  // rendering to compute the GET status and length. Refuse it instead of doing that work.
  if (req.method === "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Length", "0");
    res.end();
    return;
  }
  const clientAdmission = requestGate.admitClient(clientKey);
  if (clientAdmission.kind === "rate-limited") {
    unavailable(429, clientAdmission.retryAfterSeconds);
    return;
  }
  try {
    const { resolvePublicSessionShareToken } = await import("./control-ui-public-session-token.js");
    const locator = await resolvePublicSessionShareToken(publicShare.token);
    if (!locator) {
      unavailable(404);
      return;
    }
    if (!projection) {
      unavailable(503);
      return;
    }
    const { isPublicSessionShareActive, readPublicSessionShare } =
      await import("./control-ui-public-session-read.js");
    const { renderPublicSessionDocument } = await import("./control-ui-public-session-render.js");
    const { withReadySessionRows } = await import("./session-row-prepared-read.js");
    const admitted = await requestGate.run({
      publicationKey: locator.shareId,
      sessionKey: locator.sessionKey,
      requestKey: JSON.stringify([
        createHash("sha256").update(publicShare.token).digest("base64url"),
        offset,
        origin,
      ]),
      config: cfg,
      work: async () => {
        const session = await readPublicSessionShare(cfg, locator, { offset, projection });
        if (!session) {
          return null;
        }
        const latestUrl = buildControlUiPublicSessionSharePath({
          basePath,
          token: publicShare.token,
        });
        const canonicalUrl =
          publicOrigin || req.socket instanceof TLSSocket ? `${origin}${latestUrl}` : undefined;
        return renderPublicSessionDocument({
          ...session,
          latestUrl,
          ...(canonicalUrl ? { canonicalUrl } : {}),
          isLatest: offset === 0,
          ...(session.olderOffset !== undefined
            ? { olderUrl: `${latestUrl}&offset=${session.olderOffset}` }
            : {}),
          cardUrl: `${origin}${basePath}/share/card.png`,
        });
      },
    });
    if (admitted.kind === "rate-limited") {
      unavailable(429, admitted.retryAfterSeconds);
      return;
    }
    if (admitted.kind === "unavailable") {
      unavailable(503);
      return;
    }
    await withReadySessionRows(
      projection,
      () => [{ key: locator.sessionKey, agentId: locator.agentId }],
      () => {
        const representation = admitted.value;
        if (!representation || !isPublicSessionShareActive(cfg, locator, projection)) {
          unavailable(404);
          return;
        }
        if (!representation.isCurrent()) {
          unavailable(503);
          return;
        }
        const { body, etag } = representation;
        res.setHeader("ETag", etag);
        if (req.headers["if-none-match"] === etag) {
          res.statusCode = 304;
          res.end();
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      },
    );
  } catch {
    unavailable(503);
  }
}

export function createControlUiPublicSessionRoute(
  requestGate = createControlUiPublicSessionRequestGate(),
) {
  return {
    matches: isControlUiPublicSessionPath,
    dispose: () => requestGate.dispose(),
    reject(res: ServerResponse): true {
      respondNotFound(res);
      return true;
    },
    async serve(params: {
      req: IncomingMessage;
      res: ServerResponse;
      basePath: string;
      config: OpenClawConfig;
      ingress: GatewayAttributedIngress;
      projection?: SessionRowProjection;
    }): Promise<true> {
      const url = params.req.url ? new URL(params.req.url, "http://localhost") : undefined;
      if (!url) {
        respondNotFound(params.res);
        return true;
      }
      const publicOrigin = resolveGatewayPublicOrigin(params.config);
      const secureIngress = isSecurePublicSessionIngress(params.req, params.ingress, publicOrigin);
      await serveControlUiPublicSession(
        params.req,
        params.res,
        url,
        params.basePath,
        params.config,
        requestGate,
        params.ingress.rateLimit.subject.key,
        secureIngress,
        publicOrigin,
        params.projection,
      );
      return true;
    },
  };
}
