import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { INTERNAL_SESSION_PATH_PARAM, pathForRoute, routePageSpec } from "../../app-route-paths.ts";
import { sessionRefFromPath } from "../../app-session-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { BoardFace } from "../../lib/board/settings.ts";
import {
  buildAgentMainSessionKey,
  resolveUiConfiguredMainKey,
} from "../../lib/sessions/session-key.ts";
import { preloadSessionMessageSubscriptions } from "../../lib/sessions/session-scoped-operations.ts";
import { PendingSessionCreate } from "./pending-session-create-lazy.ts";
import { sessionRouteHints } from "./route-draft.ts";

function sessionPage(face: BoardFace) {
  return definePage({
    ...routePageSpec(face),
    // The application router temporarily maps dynamic session URLs onto the
    // static face route. Both locations describe the same loader match.
    loaderDeps: (context: ApplicationContext, location: RouteLocation): string => {
      const search = new URLSearchParams(location.search);
      const bridgedPath =
        location.pathname === pathForRoute(face, context.basePath)
          ? search.get(INTERNAL_SESSION_PATH_PARAM)
          : null;
      if (bridgedPath) {
        search.delete(INTERNAL_SESSION_PATH_PARAM);
      }
      const serializedSearch = search.toString();
      return `${gatewayPresentationScope(context.gateway).key}\u0000${bridgedPath ?? location.pathname}\u0000${
        serializedSearch ? `?${serializedSearch}` : ""
      }`;
    },
    loader: (context: ApplicationContext, options) => {
      // Subscription acquisition owns errors and retries after this speculative load.
      void preloadSessionMessageSubscriptions().catch(() => undefined);
      const creation = context.chatSubmissions.creation;
      if (creation && !creation.admitted) {
        const mainKey = resolveUiConfiguredMainKey({
          agentsList: context.agents.state.agentsList,
          hello: context.gateway.snapshot.hello,
        });
        const pathname =
          options.location.pathname === pathForRoute(face, context.basePath)
            ? (new URLSearchParams(options.location.search).get(INTERNAL_SESSION_PATH_PARAM) ??
              options.location.pathname)
            : options.location.pathname;
        const target = sessionRefFromPath(pathname, context.basePath, mainKey);
        const sessionKey =
          target?.kind === "main"
            ? buildAgentMainSessionKey({ agentId: target.agentId, mainKey })
            : target?.kind === "literal"
              ? target.sessionKey
              : undefined;
        if (target?.namespace === face && sessionKey === creation.sessionKey) {
          options.signal.throwIfAborted();
          const result = {
            kind: "session" as const,
            sessionKey,
            agentId: target.agentId,
            ...sessionRouteHints(options.location),
            face,
            creation,
          };
          // The agent menu has already loaded its pending view. Ordinary draft
          // creation enters a literal route directly and retains its preview until ready.
          return target.kind === "main"
            ? result
            : PendingSessionCreate.preload().then(() => {
                options.signal.throwIfAborted();
                return result;
              });
        }
      }
      return import("./route-loader.ts").then((module) =>
        module.loadSessionPage(context, face, options),
      );
    },
    component: () => import("./route-entry.ts"),
  });
}

export const pages = [sessionPage("chat"), sessionPage("dashboard")] as const;
