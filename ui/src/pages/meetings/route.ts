import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("meetings"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./meetings-page.tsx").then(() => ({
      header: true,
      render: (search: unknown) => html`<openclaw-meetings-page
        .routeSearch=${typeof search === "string" ? search : ""}
      ></openclaw-meetings-page>`,
    })),
});
