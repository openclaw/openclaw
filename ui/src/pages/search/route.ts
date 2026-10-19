import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("search", () =>
  import("./search-page.tsx").then((module) => module.SearchPage),
);
