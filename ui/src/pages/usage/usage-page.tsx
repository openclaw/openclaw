import { createEffect, createMemo } from "solid-js";
import type { SessionsUsageResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageProps, UsageRouteData } from "./types.ts";
import { createUsagePage } from "./usage-page-state.ts";
import { renderUsage as UsageView } from "./view.tsx";

export function UsagePage(props: { routeData?: UsageRouteData }) {
  const context = useApplication();
  const page = createUsagePage(context);
  const routeData = createMemo(() => props.routeData);
  createEffect(routeData, (data) => page.setRouteData(data));
  return (
    <openclaw-usage-page>
      <UsagePageContent state={page.read()} context={context} result={page.result()} />
    </openclaw-usage-page>
  );
}

export function UsagePageContent(props: {
  state: UsageProps;
  context: ApplicationContext;
  result: SessionsUsageResult | null;
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
