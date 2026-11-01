import type { IncomingMessage, ServerResponse } from "node:http";
import { buildControlUiPublicSessionCardPath } from "@openclaw/session-url-contract/public-share";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import {
  buildPublicSessionMediaBaseUrl,
  buildPublicSessionWidgetUrl,
} from "./control-ui-public-session-attachments.js";
import { isSecurePublicSessionIngress } from "./control-ui-public-session-ingress.js";
import { projectPublicSessionItems } from "./control-ui-public-session-project.js";
import {
  isPublicSessionShareActive,
  readPublicSessionShare,
} from "./control-ui-public-session-read.js";
import {
  PUBLIC_SESSION_CONTENT_SECURITY_POLICY,
  renderPublicSessionDocument,
} from "./control-ui-public-session-render.js";
import {
  mintExistingPublicSessionShareToken,
  mintPublicSessionWidgetToken,
  type PublicSessionShareLocator,
} from "./control-ui-public-session-token.js";
import {
  buildControlUiSessionEntryUrl,
  parseControlUiSessionReturnPath,
} from "./control-ui-session-entry-path.js";
import { resolveControlUiSessionPath } from "./control-ui-session-path-resolve.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

export { PUBLIC_SESSION_CONTENT_SECURITY_POLICY };

/** Both public routes recheck publication in the synchronous response frame, including 304s. */
export async function servePublicSessionRepresentation(params: {
  req: IncomingMessage;
  res: ServerResponse;
  config: OpenClawConfig;
  gate: ControlUiPublicSessionRequestGate;
  locator: PublicSessionShareLocator;
  projection: SessionRowProjection;
  offset: number;
  requestKey: string;
  document: Pick<
    Parameters<typeof renderPublicSessionDocument>[0],
    | "latestUrl"
    | "canonicalUrl"
    | "cardUrl"
    | "entryUrl"
    | "clientAuthBasePath"
    | "assetBasePath"
    | "mediaBaseUrl"
  >;
  olderUrl: (offset: number) => string;
  unavailable: (status: 404 | 429 | 503, retryAfterSeconds?: number) => true | Promise<true>;
}): Promise<true> {
  const { req, res, config, gate, locator, projection, offset, unavailable } = params;
  const result = await gate.run({
    kind: "transcript",
    publicationKey: locator.shareId,
    sessionKey: locator.sessionKey,
    config,
    requestKey: params.requestKey,
    work: async () => {
      const session = await readPublicSessionShare(config, locator, { offset, projection });
      if (!session) {
        return null;
      }
      const widgetUrls = new Map<string, string>();
      // Disabled hosting serves no widget documents; omit their frames rather than link 404s.
      const items = isCoreCanvasHostEnabled(config)
        ? projectPublicSessionItems(session.messages)
        : [];
      for (const item of items) {
        if (item.kind !== "message") {
          continue;
        }
        for (const { docId } of item.embeds.filter((embed) => embed.kind === "widget")) {
          const token = await mintPublicSessionWidgetToken(locator, docId);
          if (token) {
            widgetUrls.set(
              docId,
              buildPublicSessionWidgetUrl(params.document.assetBasePath ?? "", token),
            );
          }
        }
      }
      return renderPublicSessionDocument({
        ...session,
        ...params.document,
        widgetUrls,
        isLatest: offset === 0,
        ...(session.olderOffset !== undefined
          ? { olderUrl: params.olderUrl(session.olderOffset) }
          : {}),
      });
    },
    consume: (representation) =>
      withReadySessionRows(
        projection,
        () => [{ key: locator.sessionKey, agentId: locator.agentId }],
        () => {
          if (!representation || !isPublicSessionShareActive(config, locator, projection)) {
            return 404 as const;
          }
          if (!representation.isCurrent()) {
            return false as const;
          }
          const { body, etag } = representation;
          if (typeof body !== "string") {
            return 503 as const;
          }
          res.setHeader("ETag", etag);
          if (req.headers["if-none-match"] === etag) {
            res.statusCode = 304;
            res.end();
          } else {
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.setHeader("Content-Length", Buffer.byteLength(body));
            res.end(body);
          }
          return undefined;
        },
      ),
  });
  if (result.kind !== "ok") {
    await unavailable(
      result.kind === "rate-limited" ? 429 : 503,
      result.kind === "rate-limited" ? result.retryAfterSeconds : undefined,
    );
    return true;
  }
  if (result.value !== undefined) {
    await unavailable(result.value);
  }
  return true;
}

export async function serveControlUiPublicChat(params: {
  req: IncomingMessage;
  res: ServerResponse;
  basePath: string;
  config: OpenClawConfig;
  ingress: GatewayAttributedIngress;
  projection?: SessionRowProjection;
  gate: ControlUiPublicSessionRequestGate;
  auth: ResolvedGatewayAuth;
  serveApp: (path: string) => Promise<boolean>;
}): Promise<true> {
  const { req, res, basePath, config, projection, gate } = params;
  const url = new URL(req.url ?? "/", "http://localhost");
  const entryQuery = new URLSearchParams(url.searchParams);
  entryQuery.delete("offset");
  const entryPath = url.pathname + (entryQuery.size ? `?${entryQuery}` : "");
  const target = parseControlUiSessionReturnPath(entryPath, basePath);
  const publicOrigin = resolveGatewayPublicOrigin(config);
  const origin = resolveControlUiShareOrigin(req, publicOrigin);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Content-Security-Policy", PUBLIC_SESSION_CONTENT_SECURITY_POLICY);
  const end = (status: number, body: string) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(req.method === "HEAD" ? undefined : body);
    return true as const;
  };
  const offsetText = url.searchParams.get("offset") ?? "0";
  if (
    !target ||
    !origin ||
    (req.method !== "GET" && req.method !== "HEAD") ||
    url.searchParams.getAll("offset").length > 1 ||
    !/^(?:0|[1-9][0-9]{0,9})$/u.test(offsetText)
  ) {
    return end(404, "Not found");
  }
  if (req.method === "HEAD") {
    res.setHeader("Allow", "GET");
    return end(405, "");
  }
  const entryUrl = buildControlUiSessionEntryUrl(entryPath, basePath);
  const clientAuthBasePath =
    params.auth.mode === "token" || params.auth.mode === "password" ? basePath : undefined;
  const secureIngress = isSecurePublicSessionIngress(req, params.ingress, publicOrigin);
  if (!secureIngress && clientAuthBasePath !== undefined) {
    // The shell contains no session data; token/password auth remains with the app.
    await params.serveApp(entryPath);
    return true;
  }
  const unavailable = (status: 404 | 429 | 503 = 404, retryAfterSeconds = 1) => {
    if (status !== 404) {
      res.setHeader("Retry-After", status === 429 ? retryAfterSeconds : "1");
      return end(
        status,
        status === 429
          ? "Too many public session requests. Please retry later."
          : "This conversation is temporarily unavailable. Please retry.",
      );
    }
    return end(
      404,
      renderPublicSessionDocument({
        title: "Conversation unavailable",
        messages: [],
        truncated: false,
        latestUrl: url.pathname,
        entryUrl,
        clientAuthBasePath,
        assetBasePath: basePath,
        cardUrl: `${origin}${basePath}/share/card.png`,
        unavailable: true,
      }),
    );
  };
  const admitted = gate.admitClient(params.ingress.rateLimit.subject.key);
  if (admitted.kind === "rate-limited") {
    return unavailable(429, admitted.retryAfterSeconds);
  }
  if (!secureIngress) {
    return unavailable();
  }
  if (!projection) {
    return unavailable(503);
  }
  try {
    // No authentication happens on this path: all candidates are publication-filtered.
    const selected = await resolveControlUiSessionPath({
      target,
      projection,
      client: null,
      publicOnly: true,
    });
    if (!selected) {
      return unavailable();
    }
    const query = { key: selected.key, agentId: selected.agentId };
    const queries = () => [query];
    const share = await withReadySessionRows(projection, queries, () => {
      const current = projection.sharingTargetState(query);
      return current.status === "ready"
        ? resolveSessionPublicShare(current.target.entry)
        : undefined;
    });
    if (!share) {
      return unavailable();
    }
    const locator = {
      agentId: selected.agentId,
      sessionKey: selected.key,
      sessionId: share.sessionId,
      shareId: share.id,
    };
    const offset = Number(offsetText);
    const token = await mintExistingPublicSessionShareToken(locator);
    return await servePublicSessionRepresentation({
      ...params,
      locator,
      projection,
      offset,
      requestKey: JSON.stringify([
        "canonical",
        share.id,
        url.pathname,
        offset,
        origin,
        entryUrl,
        clientAuthBasePath,
      ]),
      document: {
        latestUrl: url.pathname,
        ...(token ? { mediaBaseUrl: buildPublicSessionMediaBaseUrl(basePath, token) } : {}),
        entryUrl,
        clientAuthBasePath,
        assetBasePath: basePath,
        canonicalUrl: `${origin}${url.pathname}`,
        cardUrl: token
          ? `${origin}${buildControlUiPublicSessionCardPath({ basePath, token })}`
          : `${origin}${basePath}/share/card.png`,
      },
      olderUrl: (olderOffset) => `${url.pathname}?offset=${olderOffset}`,
      unavailable,
    });
  } catch {
    return unavailable(503);
  }
}
