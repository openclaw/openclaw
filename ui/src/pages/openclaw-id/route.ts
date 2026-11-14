import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("openclaw-id", () =>
  import("./openclaw-id-page.tsx").then((module) => module.OpenClawIdPage),
);
