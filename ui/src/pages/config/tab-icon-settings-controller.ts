import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { UiSettings } from "../../app/settings.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { TabIconViewProps } from "./view-tab-icon.ts";

/** Prepares the active agent preview; ConfigPage owns preference writes. */
export class TabIconSettingsController implements ReactiveController {
  constructor(
    host: ReactiveControllerHost,
    private readonly options: {
      getContext: () => ApplicationContext;
      isActive: () => boolean;
      getPreference: () => UiSettings["tabIcon"];
      setPreference: TabIconViewProps["setTabIconMode"];
    },
  ) {
    host.addController(this);
  }

  hostUpdate() {
    const context = this.options.getContext();
    if (this.options.isActive() && context.gateway.snapshot.phase === "connected") {
      void context.agentIdentity.ensure([context.agentSelection.state.selectedId]);
    }
  }

  get props(): TabIconViewProps {
    const context = this.options.getContext();
    const id = context.agentSelection.state.selectedId;
    const agent = context.agents.state.agentsList?.agents.find((entry) => entry.id === id);
    return {
      tabIcon: this.options.getPreference(),
      tabIconAgentAvatar: agent
        ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(id))
        : null,
      setTabIconMode: this.options.setPreference,
    };
  }
}
