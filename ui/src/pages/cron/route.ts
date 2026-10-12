import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("cron"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./cron-page.tsx").then(() => ({
      header: true,
      render: (search: unknown) => html`<openclaw-cron-page
        .routeSearch=${typeof search === "string" ? search : ""}
      ></openclaw-cron-page>`,
    })),
});
