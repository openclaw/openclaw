import { defineSolidPage } from "../../app-route-types.tsx";

export const page = defineSolidPage("skill-workshop", () =>
  import("./skill-workshop-page.tsx").then((module) => module.SkillWorkshopPage),
);
