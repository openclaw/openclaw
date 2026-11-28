import { onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../src/shared/deferred.ts";
import { createApplicationRouter } from "./app-routes.ts";
import type { ApplicationContext } from "./app/context.ts";
import { mountRouterOutlet, settleRouterOutlet } from "./app/router-outlet.test-support.tsx";

it.each([
  ["new-session", "model-setup", "", "model-providers", "?connect=1"],
  ["new-session", "settings", "", "chat", ""],
  ["lobsterdex", "settings", "?keep=1", "chat", "?keep=1"],
  ["portals", "settings", "", "chat", ""],
  ["new-session", "communications", "?section=__notifications__", "notifications", ""],
  ["new-session", "communications", "?section=channels", "channels", ""],
  ["new-session", "communications", "?section=broadcast", "advanced", "?section=broadcast"],
  ["new-session", "communications", "?section=talk", "talk", "?section=talk"],
  ["new-session", "appearance", "?section=wizard", "advanced", "?section=wizard"],
  [
    "new-session",
    "advanced",
    "?section=transcripts",
    "communications",
    "?section=transcripts&advanced=1",
  ],
  ["new-session", "automation", "?section=approvals", "security", "?section=approvals"],
  ["new-session", "automation", "?section=plugins", "plugin-settings", "?tab=advanced"],
  ["new-session", "ai-agents", "?section=memory", "memory", "?section=memory"],
  ["new-session", "ai-agents", "?section=models", "model-providers", ""],
] as const)(
  "keeps %s mounted while %s %s resolves to %s",
  async (sourceId, requestedId, search, targetId, targetSearch) => {
    const router = createApplicationRouter();
    // SAFETY: This fixture replaces both page renderers/loaders at the real routing boundary.
    const context = { basePath: "/ui" } as ApplicationContext;
    const target = createDeferredCore<{ renderSolid: () => HTMLElement }>();
    const sourcePage = router.getRoute(sourceId)!;
    const targetPage = router.getRoute(targetId)!;
    let mounts = 0;
    let disposals = 0;
    const hash = requestedId === "model-setup" ? "" : "#anchor";
    const mocks = [
      vi.spyOn(sourcePage, "component").mockResolvedValue({
        renderSolid: () => {
          mounts++;
          onCleanup(() => {
            disposals++;
          });
          return document.createElement("article");
        },
      }),
      ...(sourcePage.loader ? [vi.spyOn(sourcePage, "loader").mockReturnValue(undefined)] : []),
      vi.spyOn(targetPage, "component").mockReturnValue(target.promise),
      ...(targetPage.loader ? [vi.spyOn(targetPage, "loader").mockReturnValue(undefined)] : []),
      ...(targetPage.loaderDeps ? [vi.spyOn(targetPage, "loaderDeps").mockReturnValue("")] : []),
    ];
    const outlet = mountRouterOutlet({ router, retryContext: context });
    let navigation: Promise<void> | undefined;
    try {
      await router.start(
        {
          location: () => ({
            pathname: router.pathForRoute(sourceId, "/ui"),
            search: "",
            hash: "",
          }),
          push: () => {},
          replace: () => {},
          listen: () => () => {},
        },
        "/ui",
        context,
      );
      await settleRouterOutlet(outlet);
      const original = outlet.querySelector("article");
      expect(original).not.toBeNull();
      navigation = router.navigate(
        requestedId,
        context,
        { history: "push" },
        {
          pathname: router.pathForRoute(requestedId, "/ui"),
          search,
          hash,
        },
      );
      await vi.waitFor(() => expect(targetPage.component).toHaveBeenCalled());
      await settleRouterOutlet(outlet);
      expect(outlet.querySelector("article")).toBe(original);
      expect(mounts).toBe(1);
      expect(disposals).toBe(0);
      expect(router.getState().location).toEqual({
        pathname: router.pathForRoute(targetId, "/ui"),
        search: targetSearch,
        hash,
      });
      target.resolve({ renderSolid: () => document.createElement("div") });
      await navigation;
      await settleRouterOutlet(outlet);
      expect(mounts).toBe(1);
      expect(disposals).toBe(1);
    } finally {
      target.resolve({ renderSolid: () => document.createElement("div") });
      await navigation;
      outlet.dispose();
      router.stop();
      for (const mock of mocks) {
        mock.mockRestore();
      }
    }
  },
);
