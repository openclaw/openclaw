import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../src/shared/deferred.ts";
import { createApplicationRouter } from "./app-routes.ts";
import type { ApplicationContext } from "./app/context.ts";
import { mountRouterOutlet, settleRouterOutlet } from "./app/router-outlet.test-support.tsx";

it("keeps New Session mounted while a model-setup bookmark loads Models", async () => {
  const router = createApplicationRouter();
  // SAFETY: This route-boundary fixture substitutes both page renderers and their loaders.
  const context = { basePath: "/ui" } as ApplicationContext;
  const target = createDeferredCore<{ renderSolid: () => HTMLElement }>();
  let mounts = 0;
  const sourcePage = router.getRoute("new-session")!;
  const targetPage = router.getRoute("model-providers")!;
  const mocks = [
    vi.spyOn(sourcePage, "component").mockResolvedValue({
      renderSolid: () => {
        mounts++;
        return document.createElement("openclaw-new-session-page");
      },
    }),
    vi.spyOn(sourcePage, "loader").mockReturnValue(undefined),
    vi.spyOn(targetPage, "component").mockReturnValue(target.promise),
    vi.spyOn(targetPage, "loader").mockReturnValue(undefined),
  ];
  const outlet = mountRouterOutlet({ router, retryContext: context });
  let navigation: Promise<void> | undefined;
  try {
    await router.start(
      {
        location: () => ({ pathname: "/ui/new", search: "", hash: "" }),
        push: () => {},
        replace: () => {},
        listen: () => () => {},
      },
      "/ui",
      context,
    );
    await settleRouterOutlet(outlet);
    const original = outlet.querySelector("openclaw-new-session-page");
    expect(original).not.toBeNull();
    navigation = router.navigate(
      "model-setup",
      context,
      { history: "push" },
      {
        pathname: "/ui/settings/model-setup",
        search: "",
        hash: "",
      },
    );
    await vi.waitFor(() => expect(mocks[2]).toHaveBeenCalled());
    await settleRouterOutlet(outlet);
    expect(outlet.querySelector("openclaw-new-session-page")).toBe(original);
    expect(mounts).toBe(1);
    expect(router.getState().location).toEqual({
      pathname: "/ui/settings/model-providers",
      search: "?connect=1",
      hash: "",
    });
  } finally {
    target.resolve({ renderSolid: () => document.createElement("div") });
    await navigation;
    outlet.dispose();
    router.stop();
    for (const mock of mocks) {
      mock.mockRestore();
    }
  }
});
