import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("lobsterdex", () =>
  import("./lobsterdex-page.tsx").then((module) => module.LobsterdexPage),
);
