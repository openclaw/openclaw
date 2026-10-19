import { defineSolidPage } from "../../app-route-types.ts";

export const page = defineSolidPage(
  "skill-workshop",
  () => import("./skill-workshop-page.tsx").then((module) => module.SkillWorkshopPage),
  { header: false },
);
