import { createEffect, createMemo, createProjection, latest } from "solid-js";
import { useApplication } from "../../lib/reactive/context.ts";
import { UsagePageShell } from "./page-shell.tsx";
import type { UsageRouteData } from "./types.ts";
import { createUsagePage } from "./usage-page-state.ts";
import { renderUsage } from "./view.tsx";

export function UsagePage(props: { routeData?: UsageRouteData }) {
  const context = useApplication();
  const page = createUsagePage(context);
  const routeData = createMemo(() => props.routeData);
  // Route receipts drive the usage owner's Gateway queries while preserving local presentation.
  createEffect(routeData, (data) => page.setRouteData(data));
  return (
    <openclaw-usage-page>
      <UsagePageContent page={page} />
    </openclaw-usage-page>
  );
}

export function UsagePageContent(props: { page: ReturnType<typeof createUsagePage> }) {
  // Live controls publish independently of the report's admitted completion.
  const state = createProjection(() => props.page.read());
  const scope = createMemo(() => props.page.reportScope(), {
    equals: (before, after) =>
      before.connection === after.connection && before.agentId === after.agentId,
  });
  const report = createMemo(() => {
    const page = props.page;
    const current = latest(page.read);
    const receipt = current.data.read;
    // Partial query matches (calendar or roster) stay live while their summary
    // reloads. Only a wholly unavailable replacement parks the previous report.
    const hasCurrentData = Boolean(
      current.data.totals || current.data.sessions.length || current.data.costDaily.length,
    );
    // The owner publishes before resolving its receipt. Capture no mutable store
    // here: the completed read supplies a fresh, query-fenced owner snapshot.
    return current.data.loading && receipt && !hasCurrentData
      ? receipt.then(() => page.read())
      : current;
  });
  return (
    <UsagePageShell result={props.page.result()}>
      {renderUsage(state, {
        read: report,
        get scope() {
          return scope();
        },
      })}
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
