import { html } from "lit";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageProps, UsageRouteData } from "./types.ts";
import { UsagePageModel } from "./usage-page-model.ts";
import { renderUsage } from "./view.tsx";

export type { UsageRouteData } from "./types.ts";

export function UsagePageContent(props: {
  state: UsageProps;
  context: ApplicationContext;
  result: UsagePageModel["usageResult"];
}) {
  const state: UsageProps = {
    get data() {
      return props.state.data;
    },
    get filters() {
      return props.state.filters;
    },
    get display() {
      return props.state.display;
    },
    get detail() {
      return props.state.detail;
    },
    get callbacks() {
      return props.state.callbacks;
    },
  };
  return (
    <UsagePageShell context={props.context} result={props.result}>
      {renderUsage(state)}
    </UsagePageShell>
  );
}

function UsagePageBody(props: { routeData?: UsageRouteData }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0);
  const model = new UsagePageModel(context, () => setRevision((value) => value + 1));
  const state = createMemo(() => {
    revision();
    return model.read();
  });
  model.connect();
  createEffect(
    () => props.routeData,
    (data) => model.setRouteData(data),
  );
  onCleanup(() => model.dispose());
  return (
    <UsagePageContent state={state()} context={context} result={(revision(), model.usageResult)} />
  );
}

export const UsagePage = defineSolidBridge<{ routeData: UsageRouteData | undefined }>(
  "openclaw-usage-page",
  (props) => <UsagePageBody routeData={props.routeData} />,
  { properties: { routeData: { default: undefined, attribute: false } } },
);

// The legacy router still emits Lit; its host is owned by the Solid bridge.
export const usagePageComponent = {
  header: true,
  render: (data: UsageRouteData | undefined) =>
    html`<openclaw-usage-page .routeData=${data}></openclaw-usage-page>`,
};
