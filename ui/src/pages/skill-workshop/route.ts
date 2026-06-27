import { html } from "lit";
import { definePage } from "../../router/index.ts";
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
          .onRevisionRequest=${async () => {
            throw new Error("Chat is disabled while the application migration is in progress.");
          }}
        ></openclaw-skill-workshop-page>
      `,
    })),
  loader: async (context) => {
    const state = createSkillWorkshopState();
    await loadSkillWorkshopProposals(state, context);
    return skillWorkshopRouteData(state);
  },
});
