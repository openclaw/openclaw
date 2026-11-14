/* @vitest-environment jsdom */

import { createRouter } from "@openclaw/uirouter";
import { expect, it } from "vitest";
import type { ModelCatalogResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createAuthStatus,
  createHarness,
  createPage,
  expandProvider,
  mountPage,
  publishCatalog,
} from "./model-providers-page.test-support.tsx";
import { page as modelsRoute, type ModelProvidersRouteData } from "./route.ts";

it("catches a catalog publication between route preload and page mount", async () => {
  const { context, request, deferNextAuthStatus, publishEvent } = createHarness("main");
  const ready: ModelCatalogResult = {
    providerOutcomes: [{ provider: "openai", status: "ready" }],
    models: [{ id: "fixture", name: "Fixture", provider: "openai", available: true }],
  };
  publishCatalog(context, "main", { ...ready, pendingProviders: ["openai"] });
  const releaseAuth = deferNextAuthStatus();
  const originalRequest = request.getMockImplementation()!;
  request.mockImplementation(async (method: string) => {
    if (method === "models.list") {
      return ready;
    }
    const result = await originalRequest(method);
    return method === "models.authStatus" ? createAuthStatus() : result;
  });
  const router = createRouter<"model-providers", typeof context, null, ModelProvidersRouteData>({
    routes: [{ ...modelsRoute, component: () => null }],
  });
  const preload = router.navigate("model-providers", context);
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("models.authStatus", expect.anything()),
  );
  publishEvent({
    type: "event",
    event: "chat.metadata.changed",
    payload: { agentId: "main", modelCatalogChanged: true, authChanged: false },
  });
  releaseAuth();
  await preload;
  const releaseRefreshAuth = deferNextAuthStatus();
  const page = createPage(context);
  page.routeData = router.getState().matches[0]!.data;
  try {
    mountPage(page);
    await expandProvider(page, "openai");
    await waitForSolid(() => {
      const provider = page.querySelector('[data-provider-id="openai"]');
      expect(provider?.querySelector('[data-profile-id="openai:one"] strong')?.textContent).toBe(
        "Signed-in account 1",
      );
      expect(provider?.querySelector(".model-providers__head .settings-status")?.textContent).toBe(
        "Ready",
      );
    });
  } finally {
    releaseRefreshAuth();
    router.stop();
  }
});
