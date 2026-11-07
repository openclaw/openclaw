/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  drainPageUpdates,
  requestCount,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const catalog: ModelCatalogResult = {
  models: [{ id: "fixture", name: "Fixture", provider: "openai", available: true }],
};

it.each(["agent", "reconnect"] as const)(
  "shows current auth while the %s catalog is pending",
  async (change) => {
    const h = createHarness("main");
    const original = h.request.getMockImplementation()!;
    const pending = createDeferred<ModelCatalogResult>();
    let version = 1;
    h.request.mockImplementation(async (method: string, params?: { agentId?: string }) => {
      if (method === "models.authStatus") {
        return createAuthStatus([{ displayName: `Confirmed ${params?.agentId} ${version}` }]);
      }
      if (method === "models.list") {
        return version === 1 ? catalog : pending.promise;
      }
      return original(method);
    });
    const page = appendPage(h.context);
    await waitForProviders(page);
    await waitForSolid(() => expect(page.view.props.catalogDiscovering).toBe(false));
    version = 2;
    const agentId = change === "agent" ? "writer" : "main";
    try {
      if (change === "agent") {
        h.settingsAgentSelection.state.selectedId = agentId;
        h.settingsAgentSelection.state.scopeId = agentId;
        h.notifySelection();
      } else {
        h.publishPhase("reconnecting");
        h.publishPhase("connected");
      }
      await waitForSolid(() => {
        expect(page.renderRoot.textContent).toContain(`Confirmed ${agentId} 2`);
        expect(page.renderRoot.textContent).not.toContain("Confirmed main 1");
        expect(page.view.props.catalogDiscovering).toBe(true);
      });
      const input = page.querySelector<HTMLInputElement>(".model-providers__search input")!;
      input.value = "not-present";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
      expect(page.querySelectorAll(".provider-row")).toHaveLength(0);
      input.value = "Confirmed";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await waitForSolid(() => expect(page.querySelectorAll(".provider-row")).toHaveLength(1));
      if (change === "agent") {
        h.settingsAgentSelection.state.selectedId = "main";
        h.settingsAgentSelection.state.scopeId = "main";
        h.notifySelection();
        await waitForSolid(() => expect(page.renderRoot.textContent).toContain("Confirmed main 1"));
        pending.resolve({
          models: [{ id: "late-writer", name: "Late writer", provider: "openai" }],
        });
        await drainPageUpdates(page);
        expect(page.renderRoot.textContent).not.toContain("Confirmed writer 2");
        expect(page.view.props.configuredModels.map((model) => model.id)).not.toContain(
          "late-writer",
        );
      }
    } finally {
      pending.resolve(catalog);
    }
    await waitForSolid(() => expect(page.view.props.catalogDiscovering).toBe(false));
    expect(page.renderRoot.textContent).toContain(
      change === "agent" ? "Confirmed main 1" : "Confirmed main 2",
    );
  },
);

it("publishes refreshed auth before catalog completion without starting catalog before auth", async () => {
  const h = createHarness("main");
  const original = h.request.getMockImplementation()!;
  const pending = createDeferred<ModelCatalogResult>();
  let refreshing = false;
  h.request.mockImplementation(async (method: string) => {
    if (method === "models.authStatus") {
      await original(method);
      return createAuthStatus([
        { displayName: refreshing ? "Fresh credentials" : "Old credentials" },
      ]);
    }
    if (method === "models.list") {
      return refreshing ? pending.promise : catalog;
    }
    return original(method);
  });
  const page = appendPage(h.context);
  await waitForProviders(page);
  await waitForSolid(() => expect(page.view.props.catalogDiscovering).toBe(false));
  const catalogReads = requestCount(h.request, "models.list");
  const releaseAuth = h.deferNextAuthStatus();
  refreshing = true;
  try {
    page.view.props.onRefresh();
    await drainPageUpdates(page);
    expect(requestCount(h.request, "models.list")).toBe(catalogReads);
    expect(page.renderRoot.textContent).toContain("Old credentials");
    releaseAuth();
    await waitForSolid(() => {
      expect(page.renderRoot.textContent).toContain("Fresh credentials");
      expect(page.view.props.catalogDiscovering).toBe(true);
      expect(page.view.props.refreshing).toBe(true);
      const refresh = page.querySelector<HTMLButtonElement>(".model-providers__refresh-button");
      expect(refresh?.disabled).toBe(true);
      expect(refresh?.getAttribute("aria-label")).toBe("Refreshing…");
    });
    expect(requestCount(h.request, "models.list")).toBe(catalogReads + 1);
  } finally {
    releaseAuth();
    pending.resolve(catalog);
  }
  await waitForSolid(() => expect(page.view.props.catalogDiscovering).toBe(false));
});
