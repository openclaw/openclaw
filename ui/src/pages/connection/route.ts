import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("connection", () =>
  import("./connection-page.tsx").then((module) => module.ConnectionPage),
);
