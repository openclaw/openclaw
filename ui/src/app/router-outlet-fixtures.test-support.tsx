import { createRouter, definePage, type PageDefinition, type RouteMatch } from "@openclaw/uirouter";
import type { JSX } from "@solidjs/web";
import type { SolidRouteProps } from "../app-route-types.ts";

export type OutletModule<Data> = {
  renderSolid: (props: SolidRouteProps<Data>) => JSX.Element;
  retainOnNavigate?: boolean;
  renderOwnerKey?: (
    match: Pick<RouteMatch<string, unknown, Data>, "data" | "location">,
    settled: Pick<RouteMatch<string, unknown, Data>, "data" | "location"> | undefined,
  ) => string | undefined;
};

export function routeFixtures<Id extends string, Context, Data extends object>() {
  type Module = OutletModule<Data>;
  type Page = PageDefinition<Id, Context, Module, Data>;
  const routers = new Set<ReturnType<typeof createRouter<Id, Context, Module, Data>>>();
  const isLoader = (
    value: Page["loader"] | Data | Promise<Data>,
  ): value is NonNullable<Page["loader"]> => typeof value === "function";
  return {
    page(
      id: Id,
      component: Page["component"] | Module | Promise<Module>,
      loader?: Page["loader"] | Data | Promise<Data>,
      loaderDeps?: Page["loaderDeps"],
    ) {
      return definePage<Id, Context, Module, Data>({
        id,
        path: id === "new-session" ? "/new" : `/${id}`,
        component: typeof component === "function" ? component : () => component,
        loader: isLoader(loader) || loader === undefined ? loader : () => loader,
        loaderDeps,
      });
    },
    router(...routes: Page[]) {
      const router = createRouter<Id, Context, Module, Data>({ routes });
      routers.add(router);
      return router;
    },
    dispose() {
      for (const router of routers) {
        router.stop();
      }
      routers.clear();
    },
  };
}
