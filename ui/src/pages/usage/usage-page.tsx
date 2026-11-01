import { Show, createEffect, createMemo, createProjection } from "solid-js";
import type { SessionsUsageResult } from "../../api/types.ts";
import { hasOperatorReadAccess } from "../../app/operator-access.ts";
import { formatMissingOperatorReadScopeMessage } from "../../lib/gateway-errors.ts";
import { projectGateway } from "../../lib/reactive/application.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageProps, UsageRouteData } from "./types.ts";
import { createUsagePage } from "./usage-page-state.ts";
import { renderUsage as UsageView } from "./view.tsx";

export function UsagePage(props: { routeData?: UsageRouteData }) {
  const gateway = projectGateway(useApplication().gateway);
  return (
    <openclaw-usage-page>
      <Show
        when={hasOperatorReadAccess(gateway.read().snapshot.hello?.auth ?? null)}
        fallback={<div class="callout">{formatMissingOperatorReadScopeMessage("usage")}</div>}
      >
        <UsagePageData routeData={props.routeData} />
      </Show>
    </openclaw-usage-page>
  );
}

function UsagePageData(props: { routeData?: UsageRouteData }) {
  const context = useApplication();
  const page = createUsagePage(context);
  const routeData = createMemo(() => props.routeData);
  // Route receipts drive the usage owner's Gateway queries while preserving local presentation.
  createEffect(routeData, (data) => page.setRouteData(data));
  return <UsagePageContent state={page.read()} result={page.result()} />;
}

export function UsagePageContent(props: { state: UsageProps; result: SessionsUsageResult | null }) {
  // Session keys keep hydrated details from retargeting a shared roster row;
  // other entities retain their existing id-based reconciliation.
  const state = createProjection(() => props.state, null, {
    key: (entry: { key?: unknown; id?: unknown }) => entry.key ?? entry.id,
  });
  return (
    <UsagePageShell result={props.result}>
      <UsageView {...state} />
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
