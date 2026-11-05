/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { loadModelProvidersData } from "./load.ts";
import {
  createHarness,
  createEmptyModelProvidersRouteData,
} from "./model-providers-page.test-support.tsx";
import { ModelProvidersPageBody } from "./model-providers-page.tsx";

it("keeps embedded setup and its draft mounted while the endpoint editor reconnects", async () => {
  const { context, request, snapshot, gatewaySource, publishPhase } = createHarness("main");
  snapshot.hello!.auth = { ...snapshot.hello!.auth, recoveryScope: "synthetic-setup-owner" };
  snapshot.hello!.features!.methods!.push(
    "openclaw.setup.detect",
    "openclaw.setup.auth.start",
    "openclaw.setup.auth.commit",
  );
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (method: string, _params?: unknown) => {
    switch (method) {
      case "openclaw.setup.detect":
        return {
          candidates: [],
          unavailableCandidates: [],
          manualProviders: [],
          authOptions: [
            { id: "custom-api-key", label: "Custom provider", kind: "custom", featured: true },
          ],
          prepareOptions: [],
          recommendedInstalls: [],
          workspace: "/synthetic-workspace",
          setupComplete: false,
        };
      case "openclaw.setup.auth.start":
        return { done: false, status: "running" };
      case "wizard.next":
        return {
          done: false,
          status: "running",
          step: { id: "provider-url", type: "text", message: "API Base URL" },
        };
      case "wizard.cancel":
        return { status: "cancelled" };
      default:
        return original(method);
    }
  });
  await context.runtimeConfig.ensureLoaded();
  const routeData = {
    ...createEmptyModelProvidersRouteData(context),
    data: await loadModelProvidersData(snapshot.client!, { agentId: "main" }),
  };
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <ModelProvidersPageBody routeData={routeData} />
    </ApplicationProvider>
  ));
  const button = (label: string) =>
    [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
  try {
    await waitForSolid(() => expect(button("Add account")).toBeDefined());
    button("Add account")!.click();
    await waitForSolid(() => expect(button("On this Gateway")).toBeDefined());
    button("On this Gateway")!.click();
    await waitForSolid(
      () =>
        expect(
          view.container.querySelector("[data-auth-choice=custom-api-key] button"),
        ).not.toBeNull(),
      { timeout: 5000 },
    );
    view.container
      .querySelector<HTMLButtonElement>("[data-auth-choice=custom-api-key] button")!
      .click();
    await waitForSolid(() =>
      expect(view.container.querySelector("#model-setup-wizard-text-input")).not.toBeNull(),
    );
    const input = view.container.querySelector<HTMLInputElement>("#model-setup-wizard-text-input")!;
    input.value = "https://synthetic.example/v1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    publishPhase("reconnecting");
    await waitForSolid(() => expect(context.gateway.snapshot.phase).toBe("reconnecting"));
    gatewaySource.publish({ ...snapshot, phase: "connected", hello: { ...snapshot.hello! } });
    await waitForSolid(() => {
      expect(
        view.container.querySelector<HTMLInputElement>("#model-setup-wizard-text-input")?.value,
      ).toBe("https://synthetic.example/v1");
    });
    expect(
      request.mock.calls.filter(([method]) => method === "openclaw.setup.auth.start"),
    ).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toHaveLength(0);
  } finally {
    view.unmount();
  }
});
