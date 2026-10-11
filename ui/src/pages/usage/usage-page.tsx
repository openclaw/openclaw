import { createEffect, createMemo, createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageProps, UsageRouteData } from "./types.ts";
import { UsagePageModel } from "./usage-page-model.ts";
import { renderUsage as UsageView } from "./view.tsx";

export type { UsageRouteData } from "./types.ts";

export function UsagePageContent(props: {
  state: UsageProps;
  context: ApplicationContext;
  result: UsagePageModel["usageResult"];
}) {
  return (
    <UsagePageShell context={props.context} result={props.result}>
      <UsageView {...props.state} />
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
  createEffect(
    () => context,
    () => {
      model.connect();
      return () => model.dispose();
    },
  );
  createEffect(
    () => props.routeData,
    (data) => model.setRouteData(data),
  );
  return (
    <UsagePageContent state={state()} context={context} result={(revision(), model.usageResult)} />
  );
}

export const UsagePage = defineSolidBridge<{ routeData: UsageRouteData | undefined }>(
  "openclaw-usage-page",
  (props) => <UsagePageBody routeData={props.routeData} />,
  { properties: { routeData: { default: undefined, attribute: false } } },
);
