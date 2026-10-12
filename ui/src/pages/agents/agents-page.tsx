import { createEffect, createMemo, onCleanup, untrack, useContext } from "solid-js";
import { shellLayoutOwnerForHost } from "../../app/shell-layout-owner.ts";
import { ShellLayoutProvider } from "../../app/shell-layout-traits-solid.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { useApplication } from "../../lib/reactive/context.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { AgentsPageState } from "./agents-page-state.ts";
import type { AgentsRouteData } from "./route.ts";
import { Agents, AgentsPageHeader } from "./view.tsx";

function AgentsPageContent(props: { routeData?: AgentsRouteData }) {
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
    <>
      <AgentsPageHeader />
      <SettingsWorkspace>
        <Agents {...viewProps()} />
      </SettingsWorkspace>
    </>
  );
}

defineSolidBridge<{ routeData: AgentsRouteData | undefined }>(
  "openclaw-agents-page",
  (props, host) => {
    const inherited = useContext(ShellLayoutProvider);
    const owner = shellLayoutOwnerForHost(host);
    return (
      <ShellLayoutProvider value={inherited ?? (owner ? { owner, host } : null)}>
        <AgentsPageContent {...props} />
      </ShellLayoutProvider>
    );
  },
  { properties: { routeData: { default: undefined, attribute: false } } },
);
