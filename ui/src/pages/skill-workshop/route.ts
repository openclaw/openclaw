import type { SettingsAppHost } from "../../app/app-host.ts";
import { defineRoute, type Route } from "../../router/types.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadSkillWorkshopProposals } from "../../ui/controllers/skill-workshop.ts";
import { createLazyView, renderLazyView, type LazyView } from "../../ui/lazy-view.ts";

type SkillWorkshopLoadContext = {
  app: SettingsAppHost;
};

type SkillWorkshopRenderContext = {
  state: AppViewState;
  invalidate: () => void;
};

type SkillWorkshopPageModule = typeof import("./page.ts");

const pages = new WeakMap<() => void, LazyView<SkillWorkshopPageModule>>();

function getPage(invalidate: () => void): LazyView<SkillWorkshopPageModule> {
  const current = pages.get(invalidate);
  if (current) {
    return current;
  }
  const next = createLazyView<SkillWorkshopPageModule>(() => import("./page.ts"), invalidate);
  pages.set(invalidate, next);
  return next;
}

export const route: Route<"skill-workshop", SkillWorkshopLoadContext, SkillWorkshopRenderContext> =
  defineRoute({
    id: "skill-workshop",
    path: "/skills/workshop",
    parent: "skills",
    load: ({ app }) => loadSkillWorkshopProposals(app, { force: true }),
    render: ({ state, invalidate }) =>
      renderLazyView(getPage(invalidate), (page) =>
        page.renderSkillWorkshopPage(state, invalidate),
      ),
  });
