import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("portals", () =>
  import("./portals-page.tsx").then((module) => module.PortalsPage),
);
