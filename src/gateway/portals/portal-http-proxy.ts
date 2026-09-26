import { timingSafeEqual } from "node:crypto";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import { request as requestHttp } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { createLoopbackConnectOptions } from "../../infra/loopback-connect.js";

const PORTAL_AUTH_NAME = "openclaw_portal";
// Browser cookie jars are hostname-scoped, so the stable listener port in the
// auth cookie name keeps concurrently open portals from replacing each other.
function portalAuthCookieName(listenPort: number): string {
  return `${PORTAL_AUTH_NAME}_${listenPort}`;
}

// Cookies are hostname-scoped, not port-scoped. Per-instance prefixes keep cookies
// from sibling or closed portals out of the current agent-run application.
const PORTAL_COOKIE_PREFIX = "oc_portal_";
// The portal URL carries the bearer token in its query, so the browser must never
// attach it as a Referer. The target controls its own response headers, so this is
// forced after upstream headers are copied rather than merely defaulted.
const PORTAL_REFERRER_POLICY = "no-referrer";
const MAX_WEBSOCKET_RESPONSE_HEADER_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type PortalTarget =
  | { kind: "local"; port: number }
  | {
      kind: "worker";
      environmentId: string;
      ownerEpoch: number;
      remotePort: number;
      connect: () => Promise<Duplex>;
    };

type PortalProxyTarget = {
  listenPort: number;
  target: PortalTarget;
  token: string;
  cookieNamespace: string;
  /** Published ingress authority, independent of the backend listener's TLS. */
  publicOrigin?: string;
  /** HTTPS wildcard ingress can be embedded under a different top-level site. */
  partitionedCookies?: boolean;
};

type PortalAuthorization =
  | { kind: "authorized"; requestPath: string; setCookie: boolean }
  | { kind: "unauthorized" };

function tokensEqual(candidate: string | undefined, expected: string): boolean {
  if (!candidate) {
    return false;
  }
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

function readPortalCookie(
  cookieHeader: string | undefined,
  listenPort: number,
): string | undefined {
  const authCookieName = portalAuthCookieName(listenPort);
  for (const segment of cookieHeader?.split(";") ?? []) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== authCookieName) {
      continue;
    }
    return segment.slice(separator + 1).trim();
  }
  return undefined;
}

function portalCookiePrefix(cookieNamespace: string): string {
  return `${PORTAL_COOKIE_PREFIX}${cookieNamespace}_`;
}

function readTargetCookies(
  cookieHeader: string | undefined,
  cookieNamespace: string,
): string | undefined {
  const prefix = portalCookiePrefix(cookieNamespace);
  const retained = (cookieHeader?.split(";") ?? []).flatMap((segment) => {
    const separator = segment.indexOf("=");
    if (separator <= 0) {
      return [];
    }
    const name = segment.slice(0, separator).trim();
    if (!name.startsWith(prefix) || name.length === prefix.length) {
      return [];
    }
    return [`${name.slice(prefix.length)}=${segment.slice(separator + 1).trim()}`];
  });
  const normalized = retained.join("; ");
  return normalized || undefined;
}

function rewriteTargetCookie(cookie: string, target: PortalProxyTarget): string | undefined {
  const [cookiePair, ...attributes] = cookie.split(";");
  const separator = cookiePair?.indexOf("=") ?? -1;
  if (!cookiePair || separator <= 0) {
    return undefined;
  }
  const name = cookiePair.slice(0, separator).trim();
  if (!name) {
    return undefined;
  }
  const retainedAttributes = attributes.filter((attribute) => !/^\s*domain\s*=/iu.test(attribute));
  if (target.partitionedCookies) {
    // Partition embedded state by its top-level site, retaining an app's explicit
    // SameSite restriction rather than weakening its cross-site policy.
    if (!retainedAttributes.some((attribute) => /^\s*samesite\s*=/iu.test(attribute))) {
      retainedAttributes.push(" SameSite=None");
    }
    for (const attribute of ["Secure", "Partitioned"]) {
      if (
        !retainedAttributes.some((value) => value.trim().toLowerCase() === attribute.toLowerCase())
      ) {
        retainedAttributes.push(` ${attribute}`);
      }
    }
  }
  const suffix = retainedAttributes.length > 0 ? `;${retainedAttributes.join(";")}` : "";
  return `${portalCookiePrefix(target.cookieNamespace)}${name}=${cookiePair.slice(separator + 1)}${suffix}`;
}

function parsePortalUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? "/", "http://openclaw.invalid");
  } catch {
    return undefined;
  }
}

function authorizePortalRequest(
  req: IncomingMessage,
  target: PortalProxyTarget,
): PortalAuthorization {
  const url = parsePortalUrl(req);
  const queryToken = url?.searchParams.get(PORTAL_AUTH_NAME) ?? undefined;
  const setCookie = tokensEqual(queryToken, target.token);
  if (
    !setCookie &&
    !tokensEqual(readPortalCookie(req.headers.cookie, target.listenPort), target.token)
  ) {
    return { kind: "unauthorized" };
  }
  url?.searchParams.delete(PORTAL_AUTH_NAME);
  return {
    kind: "authorized",
    requestPath: `${url?.pathname ?? "/"}${url?.search ?? ""}`,
    setCookie,
  };
}

function portalCookie(target: PortalProxyTarget, tls: boolean): string {
  const sameSite = target.partitionedCookies ? "None; Partitioned" : "Lax";
  return `${portalAuthCookieName(target.listenPort)}=${target.token}; HttpOnly; SameSite=${sameSite}; Path=/${tls ? "; Secure" : ""}`;
}

function setProxyResponseHeader(
  res: ServerResponse,
  name: string,
  value: string | string[] | number,
  target: PortalProxyTarget,
): void {
  if (name !== "set-cookie") {
    res.setHeader(name, value);
    return;
  }
  const existing = res.getHeader("Set-Cookie");
  const existingCookies =
    existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
  const targetCookies = Array.isArray(value) ? value : [String(value)];
  const rewrittenCookies = targetCookies.flatMap((cookie) => {
    const rewritten = rewriteTargetCookie(cookie, target);
    return rewritten ? [rewritten] : [];
  });
  const cookies = [...existingCookies.map(String), ...rewrittenCookies];
  if (cookies.length > 0) {
    res.setHeader("Set-Cookie", cookies);
  }
}

function htmlResponse(
  res: ServerResponse,
  statusCode: number,
  html: string,
  headOnly: boolean,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", PORTAL_REFERRER_POLICY);
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(headOnly ? undefined : html);
}

function respondPortalUnauthorized(req: IncomingMessage, res: ServerResponse): void {
  const html =
    "<!doctype html><meta charset=utf-8><title>Private portal</title>" +
    "<p>This portal is private. Open it from the OpenClaw Control UI.</p>";
  htmlResponse(res, 401, html, req.method === "HEAD");
}

function portalWaitingHtml(targetPort: number): string {
  return (
    '<!doctype html><meta charset=utf-8><meta http-equiv="refresh" content="2">' +
    `<title>Waiting for app</title><p>Waiting for the app on port ${targetPort}…</p>`
  );
}

function respondPortalWaiting(req: IncomingMessage, res: ServerResponse, targetPort: number): void {
  htmlResponse(res, 502, portalWaitingHtml(targetPort), req.method === "HEAD");
}

async function connectPortalTarget(target: PortalTarget): Promise<Duplex> {
  if (target.kind === "worker") {
    return await target.connect();
  }
  return net.connect(createLoopbackConnectOptions(target.port));
}

function connectionHeaderTokens(headers: IncomingHttpHeaders): Set<string> {
  const value = headers.connection;
  const joined = Array.isArray(value) ? value.join(",") : value;
  return new Set(
    (joined ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function proxyHeaders(headers: IncomingHttpHeaders, cookieNamespace?: string): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const connectionTokens = connectionHeaderTokens(headers);
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      value === undefined ||
      HOP_BY_HOP_HEADERS.has(normalized) ||
      connectionTokens.has(normalized)
    ) {
      continue;
    }
    // Ingress identity and caller-supplied forwarding metadata do not belong
    // to an agent-run app. The portal supplies its own forwarding facts.
    if (
      cookieNamespace !== undefined &&
      (normalized === "forwarded" ||
        normalized === "x-real-ip" ||
        normalized.startsWith("x-forwarded-") ||
        normalized.startsWith("tailscale-") ||
        normalized.startsWith("cf-access-"))
    ) {
      continue;
    }
    if (normalized === "cookie" && cookieNamespace !== undefined) {
      const cookie = readTargetCookies(
        Array.isArray(value) ? value.join("; ") : value,
        cookieNamespace,
      );
      if (cookie) {
        result.cookie = cookie;
      }
      continue;
    }
    // A referrer that still carries the bearer query would hand the target the
    // credential it is being kept away from; drop it rather than forward it.
    if (normalized === "referer" && String(value).includes(`${PORTAL_AUTH_NAME}=`)) {
      continue;
    }
    result[normalized] = value;
  }
  return result;
}

function targetRequestHeaders(
  req: IncomingMessage,
  target: PortalProxyTarget,
  tls: boolean,
): OutgoingHttpHeaders {
  const headers = proxyHeaders(req.headers, target.cookieNamespace);
  const publicUrl = target.publicOrigin ? new URL(target.publicOrigin) : undefined;
  const targetPort = target.target.kind === "local" ? target.target.port : target.target.remotePort;
  headers.host = `localhost:${targetPort}`;
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  headers["x-forwarded-proto"] = tls ? "https" : "http";
  const publicHost = publicUrl?.host ?? req.headers.host;
  if (publicHost) {
    headers["x-forwarded-host"] = publicHost;
  }
  return headers;
}

function portalRedirect(
  location: string,
  req: IncomingMessage,
  target: PortalProxyTarget,
  tls: boolean,
): string {
  // Translate only the app's absolute loopback redirects. Relative navigation
  // and intentionally external redirects retain their semantics.
  if (!/^https?:\/\//iu.test(location) && !location.startsWith("//")) {
    return location;
  }
  const origin = target.publicOrigin ?? `${tls ? "https" : "http"}://${req.headers.host}`;
  try {
    const destination = new URL(location, origin);
    const targetPort =
      target.target.kind === "local" ? target.target.port : target.target.remotePort;
    const port = Number(destination.port || (destination.protocol === "https:" ? 443 : 80));
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname) ||
      port !== targetPort ||
      destination.username ||
      destination.password
    ) {
      return location;
    }
    const published = new URL(origin);
    destination.protocol = published.protocol;
    destination.host = published.host;
    // The host setter preserves an existing port when the new host omits it.
    destination.port = published.port;
    return destination.href;
  } catch {
    return location;
  }
}

/** Proxies one authorized portal request to its local or worker target. */
export function handlePortalProxyRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  target: PortalProxyTarget;
  tls: boolean;
}): void {
  const { req, res, target, tls } = params;
  const authorization = authorizePortalRequest(req, target);
  if (authorization.kind === "unauthorized") {
    respondPortalUnauthorized(req, res);
    return;
  }
  if (authorization.setCookie) {
    res.setHeader("Set-Cookie", portalCookie(target, tls));
  }

  const headers = targetRequestHeaders(req, target, tls);
  const targetPort = target.target.kind === "local" ? target.target.port : target.target.remotePort;
  void connectPortalTarget(target.target).then(
    (targetSocket) => {
      if (req.aborted || res.destroyed) {
        targetSocket.destroy();
        return;
      }
      const proxyReq = requestHttp({
        hostname: "localhost",
        createConnection: () => targetSocket,
        port: targetPort,
        method: req.method,
        path: authorization.requestPath,
        headers,
      });
      proxyReq.once("response", (proxyRes) => {
        for (const [name, value] of Object.entries(proxyHeaders(proxyRes.headers))) {
          if (value !== undefined) {
            const forwarded =
              name === "location" && typeof value === "string"
                ? portalRedirect(value, req, target, tls)
                : value;
            setProxyResponseHeader(res, name, forwarded, target);
          }
        }
        // Overwrite, never default: a target answering with `unsafe-url` would otherwise
        // send the token-bearing portal URL to every third-party origin it references.
        res.setHeader("Referrer-Policy", PORTAL_REFERRER_POLICY);
        res.statusCode = proxyRes.statusCode ?? 502;
        proxyRes.once("error", () => res.destroy());
        // Streaming apps may wait for the client's open event before producing data.
        // Preserve the upstream header boundary instead of waiting for the first chunk.
        res.flushHeaders();
        proxyRes.pipe(res);
      });
      proxyReq.once("error", () => {
        if (!res.headersSent) {
          respondPortalWaiting(req, res, targetPort);
        } else {
          res.destroy();
        }
      });
      proxyReq.once("close", () => {
        if (target.target.kind === "worker" && !res.headersSent && !res.writableEnded) {
          respondPortalWaiting(req, res, targetPort);
        }
      });
      // A browser can leave after its request body ended (for example during SSE).
      res.once("close", () => proxyReq.destroy());
      req.pipe(proxyReq);
    },
    () => {
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        respondPortalWaiting(req, res, targetPort);
      }
    },
  );
}

function websocketHeaders(
  req: IncomingMessage,
  target: PortalProxyTarget,
  tls: boolean,
  requestPath: string,
): string {
  const lines = [`${req.method ?? "GET"} ${requestPath} HTTP/1.1`];
  const headers = targetRequestHeaders(req, target, tls);
  headers.connection = "Upgrade";
  headers.upgrade = req.headers.upgrade;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      lines.push(`${name}: ${item}`);
    }
  }
  lines.push("", "");
  return lines.join("\r\n");
}

function rejectPortalUpgrade(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain; charset=utf-8\r\n" +
      "Content-Length: 12\r\nConnection: close\r\n\r\nUnauthorized",
  );
}

function respondUpgradeWaiting(socket: Duplex, targetPort: number): void {
  const html = portalWaitingHtml(targetPort);
  socket.end(
    "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html; charset=utf-8\r\n" +
      `Cache-Control: no-store\r\nReferrer-Policy: ${PORTAL_REFERRER_POLICY}\r\n` +
      `Content-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`,
  );
}

function forwardWebSocketResponse(
  targetSocket: Duplex,
  browserSocket: Duplex,
  target: PortalProxyTarget,
  onResponse: () => void,
): void {
  let pending = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const headerEnd = pending.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (pending.length > MAX_WEBSOCKET_RESPONSE_HEADER_BYTES) {
        targetSocket.destroy();
        browserSocket.destroy();
      }
      return;
    }

    targetSocket.off("data", onData);
    const headerLines = pending.subarray(0, headerEnd).toString("latin1").split("\r\n");
    const rewrittenLines = headerLines.flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0 || line.slice(0, separator).trim().toLowerCase() !== "set-cookie") {
        return [line];
      }
      const rewritten = rewriteTargetCookie(line.slice(separator + 1).trimStart(), target);
      return rewritten ? [`${line.slice(0, separator)}: ${rewritten}`] : [];
    });
    onResponse();
    browserSocket.write(`${rewrittenLines.join("\r\n")}\r\n\r\n`);
    const remainder = pending.subarray(headerEnd + 4);
    if (remainder.length > 0) {
      browserSocket.write(remainder);
    }
    targetSocket.pipe(browserSocket);
  };
  targetSocket.on("data", onData);
}

/** Splices an authorized portal WebSocket upgrade into its local or worker target. */
export function handlePortalProxyUpgrade(params: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  target: PortalProxyTarget;
  upgradedSockets: Set<Duplex>;
  tls: boolean;
}): void {
  const { req, socket, head, target, upgradedSockets, tls } = params;
  // Node releases socket errors on upgrade; own them before replies or worker attachment.
  socket.once("error", () => socket.destroy());
  const authorization = authorizePortalRequest(req, target);
  if (authorization.kind !== "authorized") {
    rejectPortalUpgrade(socket);
    return;
  }

  const targetPort = target.target.kind === "local" ? target.target.port : target.target.remotePort;
  upgradedSockets.add(socket);
  socket.once("close", () => upgradedSockets.delete(socket));
  let responseStarted = false;
  const closeUpgrade = () => {
    if (target.target.kind === "worker" && !responseStarted && !socket.destroyed) {
      if (!socket.writableEnded) {
        respondUpgradeWaiting(socket, targetPort);
      }
      return;
    }
    socket.destroy();
  };
  void connectPortalTarget(target.target).then((targetSocket) => {
    if (socket.destroyed) {
      targetSocket.destroy();
      return;
    }
    upgradedSockets.add(targetSocket);
    socket.once("close", () => targetSocket.destroy());
    targetSocket.once("close", () => {
      upgradedSockets.delete(targetSocket);
      closeUpgrade();
    });
    targetSocket.once("end", closeUpgrade);
    targetSocket.once("error", closeUpgrade);
    const spliceUpgrade = () => {
      forwardWebSocketResponse(targetSocket, socket, target, () => {
        responseStarted = true;
      });
      targetSocket.write(websocketHeaders(req, target, tls, authorization.requestPath));
      if (head.length > 0) {
        targetSocket.write(head);
      }
      socket.pipe(targetSocket);
    };
    if (target.target.kind === "worker") {
      spliceUpgrade();
    } else {
      targetSocket.once("connect", spliceUpgrade);
    }
  }, closeUpgrade);
}
