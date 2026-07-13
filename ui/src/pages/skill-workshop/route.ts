import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createSkillWorkshopState,
  loadSkillWorkshopProposals,
  skillWorkshopRouteData,
  type SkillWorkshopRouteData,
} from "./proposals.ts";

export const page = definePage({
  id: "skill-workshop",
  path: "/skills/workshop",
  component: () =>
    import("./skill-workshop-page.ts").then(() => ({
      render: (data: unknown) => html`
        <openclaw-skill-workshop-page
          .data=${data as SkillWorkshopRouteData | undefined}
        ></openclaw-skill-workshop-page>
      `,
    })),
  loader: async (context: ApplicationContext) => {
    const state = createSkillWorkshopState();
    await loadSkillWorkshopProposals(state, context);
    return skillWorkshopRouteData(state);
  },
});
