import { createEffect, createMemo, createSignal } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageProps, UsageRouteData } from "./types.ts";
import { UsagePageModel } from "./usage-page-model.ts";
import { renderUsage as UsageView } from "./view.tsx";

export function UsagePage(props: { routeData?: UsageRouteData }) {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0);
  const model = new UsagePageModel(context, () => setRevision((value) => value + 1));
  const state = createMemo(() => {
    revision();
    return model.read();
  });
  const result = () => {
    revision();
    return model.usageResult;
  };
  createEffect(
    () => context,
    () => {
      model.connect();
      return () => model.dispose();
    },
  );
  const routeData = createMemo(() => props.routeData);
  createEffect(routeData, (data) => model.setRouteData(data));
  return (
    <openclaw-usage-page>
      <UsagePageContent state={state()} context={context} result={result()} />
    </openclaw-usage-page>
  );
}

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

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-usage-page": HTMLAttributes<HTMLElement>;
    }
  }
}
