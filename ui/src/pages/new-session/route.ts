import type { RouteLocation } from "@openclaw/uirouter";
import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { newSessionDataFromSearch } from "./location.ts";

export const page = definePage({
  id: "new-session",
  path: "/new",
  loaderDeps: (_context: ApplicationContext, location: RouteLocation) =>
    JSON.stringify(newSessionDataFromSearch(location.search)),
  loader: (_context: ApplicationContext, { location }) => newSessionDataFromSearch(location.search),
  component: () =>
    import("./new-session-page.ts").then(() => ({
      render: (data: unknown) =>
        html`<openclaw-new-session-page .data=${data}></openclaw-new-session-page>`,
    })),
});
