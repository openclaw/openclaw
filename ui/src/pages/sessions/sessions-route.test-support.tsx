import { onTestFinished } from "vitest";
import { locationForRoute } from "../../app-route-paths.ts";
import { createApplicationRouter } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { createContext, createGateway } from "./sessions-page.test-support.ts";

export async function mountSessionsRoute(request: GatewayRequestHandler) {
  const connection = createGateway(createTestGatewayClient(request));
  const sessions = createTestSessionCapability(connection.gateway);
  const router = createApplicationRouter();
  const context: ApplicationContext = {
    ...createContext(connection.gateway, sessions),
    router,
    navigate: (routeId, options) => {
      void context.navigateAndWait(routeId, options);
    },
    navigateAndWait: (routeId, options) =>
      router.navigate(
        routeId,
        context,
        { history: "none" },
        {
          ...locationForRoute(routeId, context.basePath),
          ...options,
        },
      ),
  };
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => <RouterOutlet router={router} retryContext={context} />, {
    wrapper: provider.wrapper,
  });
  const dispose = () => {
    mounted.unmount();
    router.stop();
  };
  onTestFinished(dispose);
  await context.navigateAndWait("sessions");
  return { context, router, container: mounted.container, dispose };
}
