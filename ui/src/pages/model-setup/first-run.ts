import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { resolveSessionKey } from "../../lib/sessions/index.ts";
import { cacheModelSetupDetection } from "./detect-cache.ts";
import { detectModelSetup } from "./rpc.ts";

export function isDefaultChatLanding(
  location: RouteLocation,
  basePath: string,
  routeIdFromPath: (pathname: string, basePath: string) => string | null,
): boolean {
  const routeId = routeIdFromPath(location.pathname, basePath);
  if (routeId !== null && routeId !== "chat") {
    return false;
  }
  const searchSession = new URLSearchParams(location.search).get("session")?.trim();
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const hashSession = new URLSearchParams(hash).get("session")?.trim();
  return !searchSession && !hashSession;
}

function locationsMatch(left: RouteLocation, right: RouteLocation): boolean {
  return (
    left.pathname === right.pathname && left.search === right.search && left.hash === right.hash
  );
}

export function locationsMatchDefaultLanding(
  current: RouteLocation,
  expected: RouteLocation,
  hello: GatewayHelloOk | null,
): boolean {
  if (locationsMatch(current, expected)) {
    return true;
  }
  if (!hello || current.pathname !== expected.pathname || current.hash !== expected.hash) {
    return false;
  }
  // Gateway hello adopts the canonical main-session key after bootstrap; that is not navigation.
  const currentSearch = new URLSearchParams(current.search);
  const expectedSearch = new URLSearchParams(expected.search);
  const currentSession = resolveSessionKey(currentSearch.get("session"), hello);
  const expectedSession = resolveSessionKey(expectedSearch.get("session"), hello);
  currentSearch.delete("session");
  expectedSearch.delete("session");
  return (
    currentSession === expectedSession && currentSearch.toString() === expectedSearch.toString()
  );
}

export function startModelSetupFirstRunRedirect(params: {
  context: ApplicationContext<RouteId>;
  isStillDefaultLanding: () => boolean;
}): () => void {
  let attemptedClient: GatewayBrowserClient | null = null;
  let detectionComplete = false;
  let redirected = false;
  return params.context.gateway.subscribe((snapshot) => {
    if (
      detectionComplete ||
      redirected ||
      !snapshot.connected ||
      !snapshot.client ||
      attemptedClient === snapshot.client ||
      !hasOperatorAdminAccess(snapshot.hello?.auth ?? null) ||
      isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") !== true
    ) {
      return;
    }
    const client = snapshot.client;
    attemptedClient = client;
    void detectModelSetup(client)
      .then((result) => {
        cacheModelSetupDetection(client, result);
        if (params.context.gateway.snapshot.client !== client) {
          return;
        }
        // A current-client result is terminal; only transport failures retry after reconnect.
        detectionComplete = true;
        if (!result.setupComplete && !redirected && params.isStillDefaultLanding()) {
          redirected = true;
          params.context.replace("model-setup", { search: "?firstRun=1" });
        }
      })
      .catch(() => {
        if (attemptedClient === client) {
          attemptedClient = null;
        }
      });
  });
}
