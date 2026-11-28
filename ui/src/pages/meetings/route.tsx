import { definePage } from "@openclaw/uirouter";
import { createMemo, Show } from "solid-js";
import { routePageSpec } from "../../app-route-paths.ts";
import type { SolidRouteProps } from "../../app-route-types.tsx";

export const page = definePage({
  ...routePageSpec("meetings"),
  loaderDeps: (_context, { search }) => search,
  loader: (_context, { deps }) => deps,
  component: () =>
    import("./meetings-page.tsx").then((module) => ({
      renderSolid: (props: SolidRouteProps<string>) => {
        // Pending loader data has no search yet. Only a resolved empty string lists all meetings.
        const search = createMemo((previous: string | undefined) => props.data ?? previous);
        return (
          <Show when={search() !== undefined}>
            <module.MeetingsPage routeSearch={search()} />
          </Show>
        );
      },
    })),
});
