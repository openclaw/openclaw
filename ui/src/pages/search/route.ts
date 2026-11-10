import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("search", () =>
  import("./search-page.tsx").then((module) => module.SearchPage),
);
