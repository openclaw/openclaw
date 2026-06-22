import type { RouteRenderContext } from "../../app-routes.ts";
import type { SettingsAppHost } from "../../app/app-host.ts";
import { definePage } from "../../router/index.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import { loadSkillWorkshopProposals } from "./data.ts";

type SkillWorkshopLoadContext = { app: SettingsAppHost };
type SkillWorkshopRenderContext = RouteRenderContext;

const skillWorkshopStateKeys = new WeakMap<object, string>();

export const page = definePage({
  id: "skill-workshop",
  path: "/skills/workshop",
  component: () =>
    import("./page.ts").then((module) => ({
      shell: "page" as const,
      header: true,
      render: ({ state, navigate }: SkillWorkshopRenderContext) => {
        const stateKey = `${state.sessionKey}\u0000${state.assistantAgentId ?? ""}`;
        skillWorkshopStateKeys.set(state, stateKey);
        return module.renderSkillWorkshopPage(state, navigate);
      },
      onStateChange: ({ state }: SkillWorkshopRenderContext, changed) => {
        if (!changed.has("sessionKey") && !changed.has("assistantAgentId")) {
          return;
        }
        const nextKey = `${state.sessionKey}\u0000${state.assistantAgentId ?? ""}`;
        if (skillWorkshopStateKeys.get(state) === nextKey) {
          return;
        }
        skillWorkshopStateKeys.set(state, nextKey);
        void loadSkillWorkshopProposals(state, { force: true });
      },
    })),
  loader: ({ app }: SkillWorkshopLoadContext) =>
    loadSkillWorkshopProposals(app).then(() => undefined),
});
