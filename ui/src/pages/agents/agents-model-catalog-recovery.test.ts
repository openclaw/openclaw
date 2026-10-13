/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  emitCatalogChanged,
  setPageGateway,
  snapshot,
  createAgentsPage,
} from "./agents-page.test-support.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import type { AgentsRouteData } from "./route.ts";
import { Agents } from "./view.tsx";

describe("agent model catalog recovery", () => {
  it("shows a model-catalog failure without a manual retry button", () => {
    const { container } = mountSolid(
      Agents,
      createProps({
        overview: {
          ...createProps().overview,
          modelCatalogStatus: {
            error: "model catalog unavailable",
            hasLoaded: true,
            stale: true,
            awaitingGateway: false,
          },
        },
      }),
    );

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("model catalog unavailable");
    expect(alert?.textContent).toContain(t("common.staleData"));
    expect(alert?.querySelector("button")).toBeNull();
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])(
    "recovers a cached model catalog once after same-socket suspension (lifecycle error: %s, late failure: %s)",
    async (lifecycle, lateFailure) => {
      const oldModels = [{ id: "old", name: "Old model", provider: "openai" }];
      const nextModels = [{ id: "new", name: "Recovered model", provider: "openai" }];
      const pending = deferred<{ models: ModelCatalogEntry[] }>();
      const error = new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Model catalog unavailable",
        retryable: true,
        ...(lifecycle ? { details: { reason: "gateway-suspending", phase: "draining" } } : {}),
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce({ models: oldModels })
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue({ models: nextModels });
      const client = { request } as unknown as GatewayBrowserClient;
      const page = createAgentsPage();
      page.routeData = { panel: "overview" } as AgentsRouteData;
      setPageGateway(page, client);
      page.agentsSelectedId = "main";
      page.loadActivePanelData();
      await waitForFast(() => expect(page.modelCatalog.models).toEqual(oldModels));
      emitCatalogChanged(page.context.gateway);
      if (!lateFailure) {
        pending.reject(error);
        await waitForFast(() =>
          expect(page.chatModelCatalogStatus).toMatchObject({
            awaitingGateway: lifecycle,
            error: lifecycle ? null : "Model catalog unavailable",
            stale: true,
          }),
        );
      }
      expect(page.modelCatalog.models).toEqual(oldModels);

      for (const suspensionPhase of ["draining", "accepting", "accepting"] as const) {
        page.gateway.applySnapshot(
          { ...snapshot(client), suspensionPhase },
          { initial: false, sourceChanged: false },
        );
      }
      if (lateFailure) {
        expect(request).toHaveBeenCalledTimes(2);
        pending.reject(error);
      }
      await waitForFast(() => expect(page.modelCatalog.models).toEqual(nextModels));
      expect(page.chatModelCatalogStatus).toMatchObject({ error: null, awaitingGateway: false });
      expect(request).toHaveBeenCalledTimes(3);
    },
  );
});
