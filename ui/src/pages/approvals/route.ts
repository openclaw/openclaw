import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("approvals", () =>
  import("./approvals-page.tsx").then((module) => module.ApprovalsPage),
);
