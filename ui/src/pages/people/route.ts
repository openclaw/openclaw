import { defineSolidPage } from "../../app-route-types.tsx";
import type { ApplicationContext } from "../../app/context.ts";

export const page = defineSolidPage(
  "people",
  () => import("./people-page.tsx").then((module) => module.PeoplePage),
  {
    loaderDeps: (_context: ApplicationContext, location) => location.search,
    loader: (_context: ApplicationContext, { location }) => location.search,
  },
);
