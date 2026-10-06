import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import {
  buildControlUiPublicSessionSharePath,
  parseControlUiPublicSessionShareUrl,
} from "@openclaw/session-url-contract/public-share";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import { isLoopbackHost, resolveHostName } from "./net.js";

const PUBLIC_SESSION_RATE_WINDOW_MS = 60_000;
const PUBLIC_SESSION_CLIENT_REQUEST_LIMIT = 20;
const PUBLIC_SESSION_PUBLICATION_REQUEST_LIMIT = 120;
const PUBLIC_SESSION_MAX_CLIENTS = 4_096;
const PUBLIC_SESSION_MAX_PUBLICATIONS = 2_048;
const PUBLIC_SESSION_MAX_CONCURRENT_READS = 8;
const PUBLIC_SESSION_MAX_CONCURRENT_READS_PER_PUBLICATION = 2;

type RateWindow = {
  timestamps: number[];
};

function admitRateWindow(
  windows: Map<string, RateWindow>,
  key: string,
  limit: number,
  maxEntries: number,
  now: number,
): number | undefined {
  const cutoff = now - PUBLIC_SESSION_RATE_WINDOW_MS;
  let window = windows.get(key);
  if (!window) {
    if (windows.size >= maxEntries) {
      for (const [candidateKey, candidate] of windows) {
        candidate.timestamps = candidate.timestamps.filter((timestamp) => timestamp > cutoff);
        if (candidate.timestamps.length === 0) {
          windows.delete(candidateKey);
        }
      }
    }
    if (windows.size >= maxEntries) {
      // Anonymous identities are attacker-controlled. Evict the oldest bucket
      // instead of letting map saturation deny every previously unseen viewer.
      pruneMapToMaxSize(windows, maxEntries - 1);
    }
    window = { timestamps: [] };
    windows.set(key, window);
  }
  window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);
  const oldest = window.timestamps[0];
  if (window.timestamps.length >= limit && oldest !== undefined) {
    return Math.max(1, oldest + PUBLIC_SESSION_RATE_WINDOW_MS - now);
  }
  window.timestamps.push(now);
  return undefined;
}

function isControlUiPublicSessionPath(pathname: string, basePath: string): boolean {
  return pathname === `${basePath}/share/session`;
}

function hasSingleHttpsForwardedProto(req: IncomingMessage): boolean {
  const value = req.headers["x-forwarded-proto"];
  return typeof value === "string" && value.trim().toLowerCase() === "https";
}

/** Owns HTTP delivery and its fixed process-local anonymous read budgets. */
export function createControlUiPublicSessionRoute() {
  const clientWindows = new Map<string, RateWindow>();
  const publicationWindows = new Map<string, RateWindow>();
  const activeByPublication = new Map<string, number>();
  const inFlight = new Map<string, Promise<string | null>>();
  const configIds = new WeakMap<object, number>();
  let nextConfigId = 1;
  let activeReads = 0;

  const configId = (config: OpenClawConfig): number => {
    const existing = configIds.get(config);
    if (existing !== undefined) {
      return existing;
    }
    const created = nextConfigId++;
    configIds.set(config, created);
    return created;
  };

  return {
    matches: isControlUiPublicSessionPath,
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
    }): Promise<true> {
      const { req, res, basePath, config: cfg, ingress } = params;
      const url = req.url ? new URL(req.url, "http://localhost") : undefined;
      if (!url) {
        respondNotFound(res);
        return true;
      }
      const publicOrigin = resolveGatewayPublicOrigin(cfg);
      const advertisedHttps = publicOrigin?.startsWith("https://") === true;
      const trustedProxyHttps =
        ingress.kind === "trusted-proxy" && advertisedHttps && hasSingleHttpsForwardedProto(req);
      const managedHttps =
        (ingress.kind === "tailscale-serve" || ingress.kind === "tailscale-funnel") &&
        advertisedHttps;
      const secureIngress =
        req.socket instanceof TLSSocket ||
        (ingress.kind === "direct-local" && isLoopbackHost(resolveHostName(req.headers.host))) ||
        trustedProxyHttps ||
        managedHttps;
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
        return true;
      }
      if (!secureIngress) {
        unavailable(404);
        return true;
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
      const clientRetryMs = admitRateWindow(
        clientWindows,
        ingress.rateLimit.subject.key,
        PUBLIC_SESSION_CLIENT_REQUEST_LIMIT,
        PUBLIC_SESSION_MAX_CLIENTS,
        Date.now(),
      );
      if (clientRetryMs !== undefined) {
        unavailable(429, Math.ceil(clientRetryMs / 1_000));
        return true;
      }
      try {
        const { resolvePublicSessionShareToken } =
          await import("./control-ui-public-session-token.js");
        const locator = resolvePublicSessionShareToken(publicShare.token);
        if (!locator) {
          unavailable(404);
          return true;
        }
        const { isPublicSessionShareActive, readPublicSessionShare } =
          await import("./control-ui-public-session-read.js");
        const { renderPublicSessionDocument } =
          await import("./control-ui-public-session-render.js");
        const publicationRetryMs = admitRateWindow(
          publicationWindows,
          locator.shareId,
          PUBLIC_SESSION_PUBLICATION_REQUEST_LIMIT,
          PUBLIC_SESSION_MAX_PUBLICATIONS,
          Date.now(),
        );
        if (publicationRetryMs !== undefined) {
          unavailable(429, Math.ceil(publicationRetryMs / 1_000));
          return true;
        }
        const inFlightKey = `${configId(cfg)}:${JSON.stringify([
          createHash("sha256").update(publicShare.token).digest("base64url"),
          offset,
          origin,
        ])}`;
        const existing = inFlight.get(inFlightKey);
        let body: string | null;
        if (existing) {
          body = await existing;
        } else {
          const publicationActive = activeByPublication.get(locator.shareId) ?? 0;
          if (
            activeReads >= PUBLIC_SESSION_MAX_CONCURRENT_READS ||
            publicationActive >= PUBLIC_SESSION_MAX_CONCURRENT_READS_PER_PUBLICATION
          ) {
            unavailable(503);
            return true;
          }
          activeReads += 1;
          activeByPublication.set(locator.shareId, publicationActive + 1);
          const pending = Promise.resolve().then(async () => {
            const session = await readPublicSessionShare(cfg, locator, { offset });
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
          });
          inFlight.set(inFlightKey, pending);
          try {
            body = await pending;
          } finally {
            inFlight.delete(inFlightKey);
            activeReads -= 1;
            const remaining = (activeByPublication.get(locator.shareId) ?? 1) - 1;
            if (remaining > 0) {
              activeByPublication.set(locator.shareId, remaining);
            } else {
              activeByPublication.delete(locator.shareId);
            }
          }
        }
        if (!body || !isPublicSessionShareActive(cfg, locator)) {
          unavailable(404);
          return true;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      } catch {
        unavailable(503);
      }
      return true;
    },
  };
}
