import type { IncomingMessage, ServerResponse } from "node:http";
import { parseControlUiSessionPath } from "@openclaw/session-url-contract/parse";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAssistantAgentId } from "./assistant-identity.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { createControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import {
  createControlUiPublicSessionRoute,
  isControlUiPublicSessionPath,
} from "./control-ui-public-session.js";
import { controlUiSessionEntryPath } from "./control-ui-session-entry-path.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import type { GatewayAttributedIngress } from "./ingress-attribution.js";
import type { ControlUiRootState } from "./server-control-ui-root.js";
import { getControlUiModule } from "./server-http-modules.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";

/** One HTTP-server lifetime for public document work and protected app handoffs. */
export function createControlUiSessionRoutes(options: {
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  getGatewayRequestContext?: () => GatewayRequestContext | undefined;
  isTerminalEnabled?: () => boolean;
}) {
  const basePath = normalizeControlUiBasePath(options.controlUiBasePath);
  let gate: ReturnType<typeof createControlUiPublicSessionRequestGate> | undefined;
  let legacy: ReturnType<typeof createControlUiPublicSessionRoute> | undefined;
  const publicGate = () => (gate ??= createControlUiPublicSessionRequestGate());
  return {
    matches(pathname: string, rawUrl?: string) {
      if (
        isControlUiPublicSessionPath(pathname, basePath) ||
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
      if (isControlUiPublicSessionPath(pathname, basePath)) {
        legacy ??= createControlUiPublicSessionRoute(publicGate());
        return legacy.serve({ ...params, basePath, projection });
      }
      if (pathname !== controlUiSessionEntryPath(basePath)) {
        return (await import("./control-ui-public-chat.js")).serveControlUiPublicChat({
          ...params,
          basePath,
          projection,
          gate: publicGate(),
        });
      }
      return (await import("./control-ui-session-entry.js")).serveControlUiSessionEntry({
        ...params,
        basePath,
        projection,
        serveApp: async (path, isCurrent) => {
          // The protected request supplies authority; the path selects only the
          // existing SPA document and preloads, never another HTTP handler.
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
        },
      });
    },
  };
}
