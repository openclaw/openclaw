import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("system-history", () =>
  import("./system-history-page.tsx").then((module) => module.SystemHistoryPage),
);
