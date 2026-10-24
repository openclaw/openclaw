import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("debug", () =>
  import("./debug-page.tsx").then((module) => module.DebugPage),
);
