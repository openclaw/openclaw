import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadSkillWorkshopProposals } from "../../ui/controllers/skill-workshop.ts";

type SkillWorkshopLoadContext = { app: SettingsAppHost };
type SkillWorkshopRenderContext = { state: AppViewState };

export const page = definePage({
  id: "skill-workshop",
  path: "/skills/workshop",
  component: () =>
    import("./page.ts").then((module) => ({
      shell: "page" as const,
      header: true,
      render: ({ state }: SkillWorkshopRenderContext) => module.renderSkillWorkshopPage(state),
    })),
  loader: ({ app }: SkillWorkshopLoadContext) =>
    loadSkillWorkshopProposals(app).then(() => undefined),
});
