import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

type PeopleRouteData = { personId: string; roleName: string; view: "people" | "roles" };
export const page = definePage({
  ...routePageSpec("people"),
  loaderDeps: (_context, location) => location.search,
  loader: (_context, { location }): PeopleRouteData => {
    const search = new URLSearchParams(location.search);
    return {
      personId: search.get("person") ?? "",
      roleName: search.get("role") ?? "",
      view: search.get("view") === "roles" ? "roles" : "people",
    };
  },
  component: () =>
    import("./people-page.ts").then(() => ({
      header: true,
      render: (data: PeopleRouteData | undefined) => html`<openclaw-people-page
        .personId=${data?.personId ?? ""}
        .roleName=${data?.roleName ?? ""}
        .view=${data?.view ?? "people"}
      ></openclaw-people-page>`,
    })),
});
