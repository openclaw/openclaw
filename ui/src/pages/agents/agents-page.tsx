import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { AgentsPageState } from "./agents-page-state.ts";
import type { AgentsRouteData } from "./route.ts";
import { Agents, AgentsPageHeader } from "./view.tsx";

export function AgentsPage(props: { routeData?: AgentsRouteData }) {
  const state = new AgentsPageState();
  state.context = useApplication();
  state.routeData = untrack(() => props.routeData);
  state.connect();
  state.applyRoute();
  createEffect(
    () => props.routeData,
    (routeData) => {
      if (state.routeData === routeData) {
        return;
      }
      state.routeData = routeData;
      state.applyRoute();
      state.requestUpdate();
    },
  );
  onCleanup(() => state.disconnect());
  const projection = projectSource(state, {
    read: (owner) => owner,
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality: "revision",
  });
  const viewProps = createMemo(() => projection.read().viewProps);
  return (
    <openclaw-agents-page>
      <AgentsPageHeader />
      <SettingsWorkspace>
        <Agents {...viewProps()} />
      </SettingsWorkspace>
    </openclaw-agents-page>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-agents-page": HTMLAttributes<HTMLElement>;
    }
  }
}
