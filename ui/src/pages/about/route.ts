import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("about", () =>
  import("./about-page.tsx").then((module) => module.AboutPage),
);
