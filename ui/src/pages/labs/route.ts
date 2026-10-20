import { defineSolidPage } from "../../app-route-types.ts";
import type { ApplicationContext } from "../../app/context.ts";

export const page = defineSolidPage(
  "labs",
  () => import("./labs-page.tsx").then((module) => module.LabsPage),
  { loader: (context: ApplicationContext) => context.runtimeConfig.ensureLoaded() },
);
