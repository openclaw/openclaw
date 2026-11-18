import { createEffect, createMemo } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { createSettingsTargetArrival } from "../../lib/reactive/settings-target-arrival.ts";
import { createAgentsPageState } from "./agents-page-state.ts";
import type { AgentsRouteData } from "./route.ts";
import { Agents } from "./view.tsx";

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
  let host!: HTMLElement;
  createSettingsTargetArrival(() => host);
  return (
    <openclaw-agents-page ref={(element) => (host = element)}>
      <Agents {...viewProps()} />
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
