import { createEffect, createMemo } from "solid-js";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { createAgentsPageState } from "./agents-page-state.ts";
import type { AgentsRouteData } from "./route.ts";
import { Agents, AgentsPageHeader } from "./view.tsx";

export function AgentsPage(props: { routeData?: AgentsRouteData }) {
  const context = useApplication();
  const state = createAgentsPageState(context);
  // Route receipts retarget requests before the owner starts at settle.
  createEffect(
    () => props.routeData,
    (routeData) => state.setRouteData(routeData),
  );
  const viewProps = createMemo(() => ({
    ...state.read(),
  }));
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
