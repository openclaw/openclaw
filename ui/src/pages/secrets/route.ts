import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("secrets", () =>
  import("./secrets-page.tsx").then((module) => module.SecretsPage),
);
