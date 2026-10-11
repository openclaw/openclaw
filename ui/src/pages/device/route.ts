import { definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("device"),
  component: () =>
    import("./device-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.DevicePage, {}),
    })),
});

export const permissionsPage = definePage({
  ...routePageSpec("device-permissions"),
  component: () =>
    import("./permissions-page.tsx").then((module) => ({
      header: true,
      renderSolid: () => createComponent(module.DevicePermissionsPage, {}),
    })),
});
