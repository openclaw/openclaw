import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("about", () =>
  import("./about-page.tsx").then((module) => module.AboutPage),
);
