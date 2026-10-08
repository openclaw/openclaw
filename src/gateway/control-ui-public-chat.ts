import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import { resolveSessionPublicShare } from "../config/sessions/session-public-share.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import { isSecurePublicSessionIngress } from "./control-ui-public-session-ingress.js";
import {
  isPublicSessionShareActive,
  readPublicSessionShare,
} from "./control-ui-public-session-read.js";
import {
  PUBLIC_SESSION_ENTRY_SCRIPT,
  renderPublicSessionDocument,
} from "./control-ui-public-session-render.js";
import {
  buildControlUiSessionEntryUrl,
  parseControlUiSessionReturnPath,
} from "./control-ui-session-entry-path.js";
import { resolveControlUiSessionPath } from "./control-ui-session-path-resolve.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const PROBE_HASH = createHash("sha256").update(PUBLIC_SESSION_ENTRY_SCRIPT).digest("base64");

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
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'sha256-${PROBE_HASH}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  );
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
  const admitted = gate.admitClient(params.ingress.rateLimit.subject.key);
  if (admitted.kind === "rate-limited") {
    res.setHeader("Retry-After", admitted.retryAfterSeconds);
    return end(429, "Too many public session requests. Please retry later.");
  }
  const unavailable = () =>
    end(
      404,
      renderPublicSessionDocument({
        title: "Conversation unavailable",
        messages: [],
        truncated: false,
        latestUrl: url.pathname,
        entryUrl,
        clientAuthBasePath,
        cardUrl: `${origin}${basePath}/share/card.png`,
        unavailable: true,
      }),
    );
  if (!secureIngress) {
    return unavailable();
  }
  if (!projection) {
    res.setHeader("Retry-After", "1");
    return end(503, "This conversation is temporarily unavailable. Please retry.");
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
    const result = await gate.run({
      publicationKey: share.id,
      sessionKey: selected.key,
      config,
      requestKey: JSON.stringify([
        "canonical",
        share.id,
        url.pathname,
        offset,
        origin,
        entryUrl,
        clientAuthBasePath,
      ]),
      work: async () => {
        const session = await readPublicSessionShare(config, locator, { offset, projection });
        return session
          ? renderPublicSessionDocument({
              ...session,
              latestUrl: url.pathname,
              entryUrl,
              clientAuthBasePath,
              canonicalUrl: `${origin}${url.pathname}`,
              cardUrl: `${origin}${basePath}/share/card.png`,
              isLatest: offset === 0,
              ...(session.olderOffset !== undefined
                ? { olderUrl: `${url.pathname}?offset=${session.olderOffset}` }
                : {}),
            })
          : null;
      },
    });
    if (result.kind === "rate-limited") {
      res.setHeader("Retry-After", result.retryAfterSeconds);
      return end(429, "Too many public session requests. Please retry later.");
    }
    if (result.kind === "unavailable") {
      res.setHeader("Retry-After", "1");
      return end(503, "This conversation is temporarily unavailable. Please retry.");
    }
    return await withReadySessionRows(projection, queries, () => {
      if (!result.value || !isPublicSessionShareActive(config, locator, projection)) {
        return unavailable();
      }
      if (!result.value.isCurrent()) {
        res.setHeader("Retry-After", "1");
        return end(503, "This conversation is temporarily unavailable. Please retry.");
      }
      res.setHeader("ETag", result.value.etag);
      if (req.headers["if-none-match"] === result.value.etag) {
        res.statusCode = 304;
        res.end();
        return true as const;
      }
      return end(200, result.value.body);
    });
  } catch {
    res.setHeader("Retry-After", "1");
    return end(503, "This conversation is temporarily unavailable. Please retry.");
  }
}
