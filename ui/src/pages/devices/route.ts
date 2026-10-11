import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-routes.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorPairingAccess } from "../../app/operator-access.ts";
import type { DevicesRouteData } from "./devices-page.tsx";

export const page = definePage({
  ...routePageSpec("devices"),
  loader: async (context: ApplicationContext): Promise<DevicesRouteData> => {
    const { createInitialDevicesState, loadDevices, loadExecApprovals, loadNodes } =
      await import("../../lib/nodes/page-operations.ts");
    const gateway = context.gateway;
    const gatewaySnapshot = gateway.snapshot;
    const devices = createInitialDevicesState({
      client: gatewaySnapshot.client,
      connected: gatewaySnapshot.phase === "connected",
    });
    if (gatewaySnapshot.phase !== "connected" || !gatewaySnapshot.client) {
      return { gateway, gatewaySnapshot, devices };
    }
    const auth = gatewaySnapshot.hello?.auth ?? null;
    const canPair = !auth || hasOperatorPairingAccess(auth);
    const canAdmin = hasOperatorAdminAccess(auth);
    await Promise.all([
      loadNodes(devices),
      Promise.allSettled([
        canPair && loadDevices(devices),
        context.runtimeConfig.refresh(),
        canAdmin && loadExecApprovals(devices),
      ]),
    ]);
    return { gateway, gatewaySnapshot, devices };
  },
  component: () =>
    import("./devices-page.tsx").then((module) => ({
      header: true,
      renderSolid: (props: SolidRouteProps<DevicesRouteData>) =>
        createComponent(module.DevicesPage, {
          get routeData() {
            return props.data;
          },
        }),
    })),
});
