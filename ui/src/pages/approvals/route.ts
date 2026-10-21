import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage("approvals", () =>
  import("./approvals-page.tsx").then((module) => module.ApprovalsPage),
);
