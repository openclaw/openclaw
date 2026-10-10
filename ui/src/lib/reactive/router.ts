import type { Router, RouterState } from "@openclaw/uirouter";
import { projectSource } from "./projection.ts";

/** Matching, loading, history, and route retirement remain router-owned. */
export function projectRouter<Id extends string, Context, Module, Data>(
  router: Pick<Router<Id, Context, Module, Data>, "getState" | "subscribe">,
) {
  return projectSource(router, {
    read: (source): RouterState<Id, Module, Data> => source.getState(),
    subscribe: (source, notify) => source.subscribe(notify),
    equality: "revision",
  });
}
