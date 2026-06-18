import type { SettingsAppHost } from "../../app/app-host.ts";
import { lazyPage } from "../../router/lazy-page.ts";
import { definePage, type Page } from "../../router/types.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadSkillWorkshopProposals } from "../../ui/controllers/skill-workshop.ts";

type SkillWorkshopLoadContext = {
  app: SettingsAppHost;
};

type SkillWorkshopRenderContext = {
  state: AppViewState;
  invalidate: () => void;
};

export const page: Page<SkillWorkshopLoadContext, SkillWorkshopRenderContext> = definePage({
  load: ({ app }) => loadSkillWorkshopProposals(app, { force: true }),
  render: lazyPage(
    () => import("./page.ts"),
    (module, { state, invalidate }) => module.renderSkillWorkshopPage(state, invalidate),
  ),
});
