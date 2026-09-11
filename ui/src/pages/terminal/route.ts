import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { TerminalRouteTarget } from "../../components/terminal/terminal-panel-session-types.ts";
import { resolveTerminalRouteLocation } from "./route-location.ts";

export const page = definePage({
  ...routePageSpec("terminal"),
  loader: (context: ApplicationContext, { location }) =>
    resolveTerminalRouteLocation(location, context.basePath),
  component: () =>
    import("./terminal-page.ts").then(() => ({
      render: (target: TerminalRouteTarget | undefined) =>
        html`<openclaw-terminal-page .target=${target ?? null}></openclaw-terminal-page>`,
    })),
});
