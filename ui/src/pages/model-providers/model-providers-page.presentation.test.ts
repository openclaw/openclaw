/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import * as providerData from "./data.ts";
import {
  appendPage,
  createApiKeyProviderData,
  createHarness,
  drainPageUpdates,
  expandProvider,
  modelPicker,
  openApiKeyProvider,
  publishCatalog,
  publishRouteData,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["edit", "add"] as const)(
  "keeps %s credential typing independent of a 1,000-model presentation",
  async (mode) => {
    const { context, request } = createHarness("main");
    const models = Array.from({ length: 1_000 }, (_, index) => ({
      id: `synthetic-${index}`,
      name: `Synthetic ${index}`,
      provider: "openai",
      available: true,
    }));
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) => {
      if (method === "models.list") {
        return { models };
      }
      if (method === "models.authStatus") {
        const auth = createApiKeyProviderData().authStatus!;
        return {
          ...auth,
          providerCapabilities: [
            ...auth.providerCapabilities!,
            { provider: "anthropic", apiKeySupported: true, quickApiKeySetup: true },
          ],
        };
      }
      if (method === "models.authSetApiKey") {
        throw new Error("Synthetic credential rejection");
      }
      return original(method);
    });
    const page = appendPage(context);
    await waitForProviders(page);
    if (mode === "edit") {
      const row = await expandProvider(page, "openai");
      row.querySelector<HTMLButtonElement>('button[aria-label="Set API key: OpenAI"]')!.click();
    } else {
      await openApiKeyProvider(page, "anthropic");
    }
    await drainPageUpdates(page);
    const form = mode === "edit" ? ".model-providers__inline-form" : "[data-models-key-dialog]";
    const input = page.querySelector<HTMLInputElement>(`${form} input`)!;
    const save = page.querySelector<HTMLButtonElement>(`${form} button.primary`)!;
    expect(input.value).toBe("");
    expect(save.disabled).toBe(true);
    const presentation = vi.spyOn(providerData, "buildModelProviderPresentation");

    for (const character of "abcdefghij") {
      input.value += character;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await page.updateComplete;
    }
    const builds = presentation.mock.calls.length;
    expect(input.value).toBe("abcdefghij");
    expect(save.disabled).toBe(false);
    save.click();
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledWith("models.authSetApiKey", {
        agentId: "main",
        provider: mode === "edit" ? "openai" : "anthropic",
        apiKey: "abcdefghij",
      });
      expect(page.renderRoot.textContent).toContain("Synthetic credential rejection");
      expect(input).toMatchObject({ value: "abcdefghij", disabled: false });
    });
    expect(builds).toBe(0);
  },
);

it("updates rendered facts from accepted catalog, auth, and notified mutable owners", async () => {
  const {
    context,
    request,
    runtimeConfig,
    notifyRuntimeConfig,
    settingsAgentSelection,
    notifySelection,
  } = createHarness("main");
  let notifyAgents = () => {};
  vi.spyOn(context.agents, "subscribe").mockImplementation((listener) => {
    notifyAgents = () => listener(context.agents.state);
    return () => {};
  });
  const original = request.getMockImplementation()!;
  const models = [
    { id: "first", name: "First model", provider: "openai", available: true },
    { id: "second", name: "Second model", provider: "openai", available: true },
  ];
  request.mockImplementation(async (method) => {
    if (method === "models.list") {
      return { models };
    }
    if (method === "config.get") {
      return { config: { agents: { defaults: { model: "openai/first" } } }, hash: "synthetic" };
    }
    return original(method);
  });
  const page = appendPage(context);
  await waitForProviders(page);
  await drainPageUpdates(page);
  const primary = modelPicker(page, "primary").querySelector(".picker-select__trigger")!;
  expect(primary.textContent).toContain("First model");

  const acceptedConfig = currentConfigObject(runtimeConfig.state)!;
  acceptedConfig.agents = { defaults: { model: "openai/second" } };
  acceptedConfig.models = { providers: { "synthetic-provider": {} } };
  notifyRuntimeConfig();
  await waitForSolid(() => {
    expect(primary.textContent).toContain("Second model");
    expect(page.querySelector('[data-provider-id="synthetic-provider"]')).not.toBeNull();
  });
  expect(currentConfigObject(runtimeConfig.state)).toBe(acceptedConfig);

  publishCatalog(context, "main", {
    models: models.map((model) => Object.assign({}, model, { name: `Published ${model.name}` })),
    defaultModels: { automaticUtilityModel: "openai/first" },
  });
  await waitForSolid(() => {
    expect(primary.textContent).toContain("Published Second model");
    expect(modelPicker(page, "utility").textContent).toContain("Auto · Published First model");
  });
  const data = createApiKeyProviderData();
  data.authStatus!.providers[0]!.displayName = "Published provider";
  publishRouteData(page, data);
  await waitForSolid(() =>
    expect(page.querySelector('[data-provider-id="openai"]')?.textContent).toContain(
      "Published provider",
    ),
  );

  context.agents.state.agentsList!.agents[0]!.name = "Renamed Main";
  notifyAgents();
  await waitForSolid(() => expect(page.renderRoot.textContent).toContain("Renamed Main"));
  settingsAgentSelection.state.selectedId = "writer";
  notifySelection();
  await waitForSolid(() => {
    expect(page.renderRoot.textContent).toContain("Connections for Writer");
    expect(page.renderRoot.textContent).not.toContain("Renamed Main");
  });
});

it("filters providers while typing without rebuilding the provider presentation", async () => {
  const { context } = createHarness("main");
  const page = appendPage(context);
  await waitForProviders(page);
  publishRouteData(page, createApiKeyProviderData());
  await page.updateComplete;
  const search = page.querySelector<HTMLInputElement>(".model-providers__search input")!;
  const presentation = vi.spyOn(providerData, "buildModelProviderPresentation");

  for (const value of ["o", "op", "missing"]) {
    search.value = value;
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
  }

  await waitForSolid(() => expect(page.querySelectorAll("[data-provider-id]")).toHaveLength(0));
  expect(presentation).not.toHaveBeenCalled();
});
