import { html } from "lit";
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { LitContent } from "../../components/solid/lit-content.tsx";
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
    <>
      <AgentsPageHeader />
      <section class="settings-workspace">
        <LitContent
          content={() =>
            html`<span hidden ${shellLayoutTraits({ settingsWorkspace: true })}></span>`
          }
        />
        <div class="settings-workspace__body">
          <Agents {...viewProps()} />
        </div>
      </section>
    </>
  );
}

export const header = true;
export const render = (data: AgentsRouteData | undefined) =>
  html`<openclaw-agents-page .routeData=${data}></openclaw-agents-page>`;
