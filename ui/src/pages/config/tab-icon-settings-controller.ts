import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import type { UiSettings } from "../../app/settings.ts";
import { getLobsterdex, subscribeLobsterdex } from "../../components/lobster-dex.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { TabIconViewProps } from "./view-tab-icon.ts";

/** Prepares artwork choices; ConfigPage retains ownership of preference writes. */
export class TabIconSettingsController implements ReactiveController {
  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      getContext: () => ApplicationContext;
      isActive: () => boolean;
      getPreference: () => UiSettings["tabIcon"];
      setPreference: TabIconViewProps["setTabIconMode"];
    },
  ) {
    host.addController(this);
  }

  private stopLobsterdex: (() => void) | undefined;

  hostConnected() {
    this.stopLobsterdex = subscribeLobsterdex(() => this.host.requestUpdate());
  }

  hostDisconnected() {
    this.stopLobsterdex?.();
    this.stopLobsterdex = undefined;
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
    const unlocked = getLobsterdex();
    return {
      tabIcon: this.options.getPreference(),
      tabIconAgentAvatar: agent
        ? resolveAgentAvatarUrl(agent, context.agentIdentity.get(id))
        : null,
      tabIconLobsters: LOBSTER_PET_PALETTES.filter((palette) => unlocked.has(palette.id)),
      setTabIconMode: (preference) => {
        if (preference.startsWith("lobster:")) {
          const lobsterId = preference.slice("lobster:".length);
          if (
            !LOBSTER_PET_PALETTES.some((palette) => palette.id === lobsterId) ||
            !getLobsterdex().has(lobsterId)
          ) {
            return;
          }
        }
        this.options.setPreference(preference);
      },
    };
  }
}
