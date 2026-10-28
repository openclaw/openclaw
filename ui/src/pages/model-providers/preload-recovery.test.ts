/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { ModelCatalogResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loadModelProvidersData } from "./load.ts";
import {
  createAuthStatus,
  createHarness,
  createPage,
  expandProvider,
  mountPage,
  publishCatalog,
  publishRouteData,
} from "./model-providers-page.test-support.tsx";

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
  const preload = loadModelProvidersData(context.gateway.snapshot.client!, { agentId: "main" });
  publishEvent({
    type: "event",
    event: "chat.metadata.changed",
    payload: { agentId: "main", modelCatalogChanged: true, authChanged: false },
  });
  releaseAuth();
  const data = await preload;
  const releaseRefreshAuth = deferNextAuthStatus();
  const page = createPage(context);
  publishRouteData(page, data);
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
  }
});
