import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("agents-home", () =>
  import("./agents-home-page.tsx").then((module) => module.AgentsHomePage),
);
