import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("device", () =>
  import("./device-page.tsx").then((module) => module.DevicePage),
);

export const permissionsPage = defineSolidPage("device-permissions", () =>
  import("./permissions-page.tsx").then((module) => module.DevicePermissionsPage),
);
