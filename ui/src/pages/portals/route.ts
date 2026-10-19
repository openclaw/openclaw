import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("portals", () =>
  import("./portals-page.tsx").then((module) => module.PortalsPage),
);
