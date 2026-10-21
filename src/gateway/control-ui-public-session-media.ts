import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { detectMime } from "@openclaw/media-core/mime";
import { parseControlUiPublicSessionShareUrl } from "@openclaw/session-url-contract/public-share";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { readCanvasDocumentHtmlSource } from "../canvas/documents.js";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildBoardWidgetContentSecurityPolicy } from "./board-sandbox.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import {
  getPublicSessionEntryId,
  readPublicSessionAttachment,
} from "./control-ui-public-session-attachments.js";
import { isSecurePublicSessionIngress } from "./control-ui-public-session-ingress.js";
import {
  isPublicSessionShareActive,
  readPublicSessionMessage,
  readPublicSessionWidget,
} from "./control-ui-public-session-read.js";
import {
  resolvePublicSessionShareToken,
  resolvePublicSessionWidgetToken,
} from "./control-ui-public-session-token.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const PUBLIC_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function serveControlUiPublicSessionMedia(params: {
  req: IncomingMessage;
  res: ServerResponse;
  basePath: string;
  config: OpenClawConfig;
  ingress: GatewayAttributedIngress;
  projection?: SessionRowProjection;
  gate: ControlUiPublicSessionRequestGate;
}): Promise<true> {
  const { req, res, config, basePath, gate, projection } = params;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  const url = new URL(req.url ?? "/", "http://localhost");
  const widgetToken = url.searchParams.get("widget");
  const unavailable = (status: 404 | 429 | 503, retryAfterSeconds = 1) => {
    const body =
      status === 404
        ? widgetToken !== null
          ? "This widget is unavailable."
          : "This public session is unavailable."
        : status === 429
          ? "Too many public session requests. Please retry later."
          : "This public session is temporarily unavailable. Please retry.";
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    if (status !== 404) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }
    res.end(req.method === "HEAD" ? undefined : body);
    return true as const;
  };
  const entryId = url.searchParams.get("entry") ?? "";
  const attachmentId = url.searchParams.get("attachment") ?? "";
  const queryKeys = widgetToken === null ? ["token", "entry", "attachment"] : ["widget"];
  const tokenUrl = new URL(`${basePath}/share/session`, url.origin);
  tokenUrl.searchParams.set("token", url.searchParams.get("token") ?? "");
  const share = parseControlUiPublicSessionShareUrl(tokenUrl, basePath);
  const publicOrigin = resolveGatewayPublicOrigin(config);
  if (
    (widgetToken === null && !share) ||
    url.href.length > 16384 ||
    queryKeys.some((key) => url.searchParams.getAll(key).length !== 1) ||
    [...url.searchParams.keys()].some((key) => !queryKeys.includes(key)) ||
    (widgetToken === null
      ? entryId.length === 0 ||
        entryId.length > 1024 ||
        !/^(?:content|media)-(?:0|[1-9][0-9]{0,5})$/u.test(attachmentId)
      : widgetToken.length === 0) ||
    (req.method !== "GET" && req.method !== "HEAD") ||
    !resolveControlUiShareOrigin(req, publicOrigin) ||
    !isSecurePublicSessionIngress(req, params.ingress, publicOrigin)
  ) {
    return unavailable(404);
  }
  if (req.method === "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Length", "0");
    res.end();
    return true;
  }
  const client = gate.admitClient(params.ingress.rateLimit.subject.key);
  if (client.kind === "rate-limited") {
    return unavailable(429, client.retryAfterSeconds);
  }
  try {
    const widget = widgetToken === null ? null : await resolvePublicSessionWidgetToken(widgetToken);
    const locator =
      widgetToken === null ? await resolvePublicSessionShareToken(share!.token) : widget?.locator;
    if (!locator) {
      return unavailable(404);
    }
    if (!projection) {
      return unavailable(503);
    }
    const tokenDigest = createHash("sha256")
      .update(widgetToken ?? share!.token)
      .digest("base64url");
    const result = await gate.run({
      kind: "transcript",
      publicationKey: locator.shareId,
      sessionKey: locator.sessionKey,
      config,
      requestKey: JSON.stringify(
        widgetToken === null
          ? ["media", tokenDigest, entryId, attachmentId]
          : ["widget", tokenDigest],
      ),
      work: async () => {
        if (widget) {
          if (
            !isCoreCanvasHostEnabled(config) ||
            !(await readPublicSessionWidget(config, locator, { docId: widget.docId, projection }))
          ) {
            return null;
          }
          try {
            const document = await readCanvasDocumentHtmlSource(widget.docId);
            return document.cspSandbox === "scripts" ? document.html : null;
          } catch {
            return null;
          }
        }
        const message = await readPublicSessionMessage(config, locator, { entryId, projection });
        if (!message || getPublicSessionEntryId(message) !== entryId) {
          return null;
        }
        return await readPublicSessionAttachment(message, attachmentId, locator);
      },
    });
    if (result.kind !== "ok") {
      return unavailable(
        result.kind === "rate-limited" ? 429 : 503,
        result.kind === "rate-limited" ? result.retryAfterSeconds : undefined,
      );
    }
    const representation = result.value;
    const body = representation?.body;
    const mime =
      widgetToken !== null
        ? typeof body === "string" && isCoreCanvasHostEnabled(config)
          ? "text/html; charset=utf-8"
          : undefined
        : Buffer.isBuffer(body) && body.byteLength <= MAX_IMAGE_BYTES
          ? await detectMime({ buffer: body })
          : undefined;
    return withReadySessionRows(
      projection,
      () => [{ key: locator.sessionKey, agentId: locator.agentId }],
      () => {
        if (
          !isPublicSessionShareActive(config, locator, projection) ||
          !mime ||
          (widgetToken === null && !PUBLIC_IMAGE_TYPES.has(mime))
        ) {
          return unavailable(404);
        }
        if (!representation?.isCurrent()) {
          return unavailable(503);
        }
        res.setHeader("Content-Disposition", "inline");
        res.setHeader("Content-Type", mime);
        if (widgetToken !== null) {
          res.setHeader(
            "Content-Security-Policy",
            `${buildBoardWidgetContentSecurityPolicy({ grantState: "none" })}; frame-ancestors 'self'`,
          );
        }
        res.setHeader("ETag", representation.etag);
        if (req.headers["if-none-match"] === representation.etag) {
          res.statusCode = 304;
          res.end();
        } else {
          res.statusCode = 200;
          res.setHeader("Content-Length", Buffer.byteLength(body!));
          res.end(body);
        }
        return true as const;
      },
    );
  } catch {
    return unavailable(503);
  }
}
