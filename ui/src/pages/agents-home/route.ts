import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("agents-home", () =>
  import("./agents-home-page.tsx").then((module) => module.AgentsHomePage),
);
