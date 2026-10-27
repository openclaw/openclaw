import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TLSSocket } from "node:tls";
import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";
import {
  buildControlUiPublicSessionSharePath,
  buildControlUiPublicSessionCardPath,
  parseControlUiPublicSessionShareUrl,
  parseControlUiPublicSessionCardUrl,
} from "@openclaw/session-url-contract/public-share";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAssistantAgentId } from "./assistant-identity.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { createControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import { buildPublicSessionMediaBaseUrl } from "./control-ui-public-session-attachments.js";
import type { PublicSessionCardRenderer } from "./control-ui-public-session-card.js";
import { isSecurePublicSessionIngress } from "./control-ui-public-session-ingress.js";
import { controlUiSessionEntryPath } from "./control-ui-session-entry-path.js";
import { resolveControlUiShareOrigin } from "./control-ui-share.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";
import { getControlUiModule } from "./server-http-modules.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";

let publicSessionModule:
  | Promise<typeof import("./control-ui-public-session.runtime.js")>
  | undefined;

function isControlUiPublicSessionPath(pathname: string, basePath: string): boolean {
  return (
    pathname === `${basePath}/share/session` || pathname === `${basePath}/share/session/card.png`
  );
}

/** One HTTP-server lifetime for public document work and protected app handoffs. */
export function createControlUiSessionRoutes(options: {
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  isTerminalEnabled?: () => boolean;
}) {
  const basePath = normalizeControlUiBasePath(options.controlUiBasePath);
  let gate: ReturnType<typeof createControlUiPublicSessionRequestGate> | undefined;
  let renderer: Promise<PublicSessionCardRenderer> | undefined;
  const publicGate = () => (gate ??= createControlUiPublicSessionRequestGate());
  return {
    matches(pathname: string, rawUrl?: string) {
      if (
        isControlUiPublicSessionPath(pathname, basePath) ||
        pathname === `${basePath}/share/session/media` ||
        pathname === controlUiSessionEntryPath(basePath)
      ) {
        return true;
      }
      if (!pathname.startsWith(`${basePath}/chat/`) || pathname === `${basePath}/chat/`) {
        return false;
      }
      // Catalog links address external provider threads, not persisted publications.
      const target = parseControlUiSessionPath(pathname, basePath);
      const query = new URL(rawUrl ?? pathname, "http://localhost").searchParams;
      return !(
        target?.kind === "main" &&
        ["catalog", "host", "thread"].every(
          (key) => query.getAll(key).length === 1 && query.get(key)?.trim(),
        )
      );
    },
    reject(res: ServerResponse): true {
      respondNotFound(res);
      return true;
    },
    dispose() {
      gate?.dispose();
      void renderer?.then((current) => current.dispose());
    },
    async serve(
      params: GatewayHttpRequestAuthOptions & {
        req: IncomingMessage;
        res: ServerResponse;
        config: OpenClawConfig;
        ingress: GatewayAttributedIngress;
      },
    ): Promise<true> {
      const { req, res, config } = params;
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const projection = getSessionRowProjection(options.getGatewayRequestContext?.());
      const serveApp = async (path: string, isCurrent?: () => boolean) => {
        // Select only the SPA document and preloads, never another HTTP handler.
        // Authenticated handoffs additionally recheck their live authority.
        const originalUrl = req.url;
        req.url = path;
        try {
          return await (
            await getControlUiModule()
          ).handleControlUiHttpRequest(req, res, {
            ...params,
            basePath,
            root: options.controlUiRoot,
            terminalEnabled: options.isTerminalEnabled?.() ?? isTerminalConfigEnabled(config),
            agentId: resolveAssistantAgentId(config),
            sessionEntryPath: path,
            isSessionEntryCurrent: isCurrent,
          });
        } finally {
          req.url = originalUrl;
        }
      };
      if (pathname === `${basePath}/share/session/media`) {
        return (
          await import("./control-ui-public-session-media.js")
        ).serveControlUiPublicSessionMedia({
          ...params,
          basePath,
          projection,
          gate: publicGate(),
        });
      }
      if (isControlUiPublicSessionPath(pathname, basePath)) {
        const requestGate = publicGate();
        const { PUBLIC_SESSION_CONTENT_SECURITY_POLICY, servePublicSessionRepresentation } =
          await (publicSessionModule ??= import("./control-ui-public-session.runtime.js"));
        const card = {
          pullRequests: options.getGatewayRequestContext?.()?.controlUiSessionPullRequests,
          render: async (cardInput: Parameters<PublicSessionCardRenderer["render"]>[0]) => {
            renderer ??= import("./control-ui-public-session-card.js").then((module) =>
              module.createPublicSessionCardRenderer(),
            );
            return (await renderer).render(cardInput);
          },
          fallback: async () => {
            res.setHeader("Cache-Control", "no-store");
            const { readControlUiRootAsset } = await import("./server-control-ui-root.js");
            const root = options.controlUiRoot;
            const asset =
              root && (root.kind === "bundled" || root.kind === "resolved")
                ? await readControlUiRootAsset(root, "social-card.png", true)
                : undefined;
            const body = asset?.file.body;
            if (!body) {
              respondNotFound(res);
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Content-Length", body.byteLength);
            res.end(req.method === "HEAD" ? undefined : body);
          },
        };
        const publicRequest = { ...params, basePath, projection, gate: requestGate, card };
        const url = req.url ? new URL(req.url, "http://localhost") : undefined;
        if (!url) {
          respondNotFound(res);
          return true;
        }
        const publicOrigin = resolveGatewayPublicOrigin(config);
        const isCard = url.pathname === `${basePath}/share/session/card.png`;
        const secureIngress = isSecurePublicSessionIngress(req, params.ingress, publicOrigin);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Robots-Tag", "noindex, nofollow");
        res.setHeader("Content-Security-Policy", PUBLIC_SESSION_CONTENT_SECURITY_POLICY);
        const unavailable = (status: 404 | 429 | 503, retryAfterSeconds = 1) => {
          if (isCard) {
            return card.fallback().then(() => true as const);
          }
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
        const publicShare = isCard
          ? parseControlUiPublicSessionCardUrl(url, basePath)
          : parseControlUiPublicSessionShareUrl(url, basePath);
        const origin = resolveControlUiShareOrigin(req, publicOrigin);
        const offsetText = url.searchParams.get("offset") ?? "0";
        const offset = Number(offsetText);
        if (
          (req.method !== "GET" && req.method !== "HEAD") ||
          !publicShare ||
          !origin ||
          !config ||
          url.searchParams.getAll("offset").length > 1 ||
          !/^(?:0|[1-9][0-9]{0,9})$/u.test(offsetText)
        ) {
          return unavailable(404);
        }
        if (!secureIngress) {
          return unavailable(404);
        }
        // A truthful HEAD would still need authorization, transcript I/O, projection, and
        // rendering to compute the GET status and length. Refuse it instead of doing that work.
        if (req.method === "HEAD") {
          if (isCard) {
            return unavailable(404);
          }
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
          const { resolvePublicSessionShareToken } =
            await import("./control-ui-public-session-token.js");
          const locator = await resolvePublicSessionShareToken(publicShare.token);
          if (!locator) {
            return unavailable(404);
          }
          if (!projection) {
            return unavailable(503);
          }
          if (isCard) {
            const { servePublicSessionCardRepresentation } =
              await import("./control-ui-public-session-card-response.js");
            return await servePublicSessionCardRepresentation({
              ...publicRequest,
              locator,
              projection,
              host: new URL(origin).host,
              token: publicShare.token,
            });
          }
          const latestUrl = buildControlUiPublicSessionSharePath({
            basePath,
            token: publicShare.token,
          });
          const canonicalUrl =
            publicOrigin || req.socket instanceof TLSSocket ? `${origin}${latestUrl}` : undefined;
          return await servePublicSessionRepresentation({
            ...publicRequest,
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
              mediaBaseUrl: buildPublicSessionMediaBaseUrl(basePath, publicShare.token),
              canonicalUrl,
              assetBasePath: basePath,
              cardUrl: `${origin}${buildControlUiPublicSessionCardPath({ basePath, token: publicShare.token })}`,
            },
            olderUrl: (olderOffset) => `${latestUrl}&offset=${olderOffset}`,
            unavailable,
          });
        } catch {
          return unavailable(503);
        }
      }
      if (pathname !== controlUiSessionEntryPath(basePath)) {
        return (
          await (publicSessionModule ??= import("./control-ui-public-session.runtime.js"))
        ).serveControlUiPublicChat({
          ...params,
          basePath,
          projection,
          gate: publicGate(),
          serveApp,
        });
      }
      return (await import("./control-ui-session-entry.js")).serveControlUiSessionEntry({
        ...params,
        basePath,
        projection,
        serveApp,
      });
    },
  };
}
