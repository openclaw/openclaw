import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("debug", () =>
  import("./debug-page.tsx").then((module) => module.DebugPage),
);
