import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("secrets", () =>
  import("./secrets-page.tsx").then((module) => module.SecretsPage),
);
