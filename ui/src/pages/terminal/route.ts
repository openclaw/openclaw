import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

// The page resolves its target itself so the resolver stays off the startup path.
export const page = definePage({
  ...routePageSpec("terminal"),
  loader: (_context: unknown, { location }: { location: RouteLocation }) => location,
  component: () =>
    import("./terminal-page.ts").then(() => ({
      render: (location: RouteLocation | undefined) =>
        html`<openclaw-terminal-page .location=${location ?? null}></openclaw-terminal-page>`,
    })),
});
