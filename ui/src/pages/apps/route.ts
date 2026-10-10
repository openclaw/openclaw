import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("apps"),
  loaderDeps: (_context, location) => location.search,
  loader: (_context, { location }) => location.search,
  component: () =>
    import("./apps-page.ts").then(() => ({
      header: true,
      render: (search: string | undefined) =>
        html`<openclaw-apps-page .appSearch=${search ?? ""}></openclaw-apps-page>`,
    })),
});
