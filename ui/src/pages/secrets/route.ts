import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("secrets", () =>
  import("./secrets-page-entry.ts").then((module) => module.loadSecretsPage()),
);
