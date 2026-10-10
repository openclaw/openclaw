import { createRouter, type RouterHistory } from "@openclaw/uirouter";
// @vitest-environment node
import { createEffect, createRoot, flush } from "@solidjs/signals";
import { expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { projectRouter } from "./router.ts";

it("projects real pending/completed navigation without taking loader ownership", async () => {
  const load = createDeferred<string>();
  const router = createRouter({
    routes: [
      { id: "home", path: "/", component: () => "home" },
      { id: "detail", path: "/detail", component: () => "detail", loader: () => load.promise },
    ],
  });
  const history: RouterHistory = {
    location: () => ({ pathname: "/", search: "", hash: "" }),
    push: () => {},
    replace: () => {},
    listen: () => () => {},
  };
  await router.start(history, "/", undefined);
  const projection = projectRouter(router);
  const states: string[] = [];
  const dispose = createRoot((stop) => {
    createEffect(
      () => projection.read().status,
      (value) => {
        states.push(value);
      },
    );
    return stop;
  });
  flush();
  try {
    expect(projection.read().location.pathname).toBe("/");
    const navigation = router.navigate("detail", undefined);
    flush();
    expect(projection.read().pendingMatches[0]?.routeId).toBe("detail");
    expect(states).toContain("loading");
    load.resolve("loaded");
    await navigation;
    flush();
    expect(projection.read().matches[0]?.data).toBe("loaded");
    const replacement = createRouter<"home" | "detail", unknown, string, string>({ routes: [] });
    projection.replaceSource(replacement);
    flush();
    expect(projection.read().status).toBe("idle");
    projection.dispose();
    await router.navigate("home", undefined);
    flush();
    expect(projection.read().status).toBe("idle");
  } finally {
    dispose();
    projection.dispose();
    router.stop();
  }
});
