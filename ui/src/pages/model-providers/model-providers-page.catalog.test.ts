/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { openPicker } from "../../test-helpers/select-picker.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  chatModelPickers,
  createAuthStatus,
  createEmptyModelProvidersRouteData,
  createHarness,
  displayedCatalog,
  drainPageUpdates,
  modelPicker,
  openModelPicker,
  publishCatalog,
  retryCatalog,
  requestCount,
  waitForProviders,
  publishRouteData,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.tsx";
import {
  expectAbsent,
  expectPresent,
  model as catalogModel,
  profile as authProfile,
  click,
  expectContent,
  waitForText,
} from "./model-providers.test-fixtures.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const progress = ".model-providers__catalog-progress";
const warning = progress + '[role="alert"]';
const pendingProgress = progress + '[role="status"]';
const option = (value: string) => '[role="option"][data-value="' + value + '"]';
const selected = '[role="option"][aria-selected="true"]';
const preparedCatalog: ModelCatalogResult = {
  models: ["primary", "utility", "fallback"].map((role) =>
    catalogModel("prepared-" + role, "Prepared " + role),
  ),
  decisionModels: [{ id: "jev-latest", name: "Jev", provider: "typesafe", pluginId: "typesafe" }],
};
const savedModelConfig = {
  agents: {
    defaults: {
      model: { primary: "openai/prepared-primary", fallbacks: ["openai/prepared-fallback"] },
      utilityModel: "openai/prepared-utility",
      decisionModel: "typesafe/jev-latest",
    },
  },
};
const recovered = (id = "recovered"): ModelCatalogResult => ({
  models: [...preparedCatalog.models, catalogModel(id, id)],
});

function createCatalogHarness(lastAcceptedCatalog?: ModelCatalogResult) {
  const harness = createHarness("main");
  if (lastAcceptedCatalog) {
    publishCatalog(harness.context, "main", lastAcceptedCatalog);
    invalidateModelCatalogCache(harness.snapshot.client!);
  }
  const originalRequest = harness.request.getMockImplementation()!;
  const discover = vi.fn<() => Promise<ModelCatalogResult>>();
  const readPublished = vi.fn((): ModelCatalogResult => preparedCatalog);
  const catalogRequest = async (method: string, params?: { refresh?: boolean }) => {
    if (method === "models.list") {
      return params?.refresh ? discover() : readPublished();
    }
    if (method === "config.get") {
      return { config: savedModelConfig, hash: "saved-model-config" };
    }
    return originalRequest(method);
  };
  harness.request.mockImplementation(catalogRequest);
  return {
    ...harness,
    discover,
    readPublished,
    catalogRequest,
    async mount() {
      const page = appendPage(harness.context);
      await waitForProviders(page, savedModelConfig);
      return page;
    },
    announce(event = "chat.metadata.changed") {
      harness.publishEvent({ type: "event", event, payload: {} });
    },
  };
}
async function expectCatalog(page: ModelProvidersPageTestElement, catalog: ModelCatalogResult) {
  await waitForSolid(() => expect(displayedCatalog(page)?.models).toEqual(catalog.models));
  await drainPageUpdates(page);
}
async function expectSavedChoices(page: ModelProvidersPageTestElement) {
  const choices = [];
  for (const picker of chatModelPickers(page)) {
    await openPicker(picker);
    choices.push(picker.querySelector(selected)?.getAttribute("data-value"));
  }
  expect(choices).toEqual([
    "openai/prepared-primary",
    "openai/prepared-utility",
    "openai/prepared-fallback",
  ]);
}
function replaceRoute(page: ModelProvidersPageTestElement, catalogError: string | null = null) {
  publishCatalog(page.context, "main", preparedCatalog);
  page.routeData = {
    ...createEmptyModelProvidersRouteData(page.context),
    gatewaySnapshot: page.context.gateway.snapshot,
    client: page.context.gateway.snapshot.client,
    data: { ...EMPTY_MODEL_PROVIDERS_DATA, catalogError, updatedAt: 2 },
  };
}

describe("Models page catalog publication", () => {
  it.each([
    {
      pin: "second",
      profiles: [
        authProfile("openai:first"),
        authProfile("openai:second", { email: "second@example.com" }),
      ],
      expected: "Subscription · second@example.com",
    },
    {
      profiles: [
        authProfile("openai:expired", { status: "expired" }),
        authProfile("openai:first", { status: "expiring", email: "first@example.com" }),
      ],
      plan: "Other account plan",
      expected: "Subscription · first@example.com",
    },
    {
      pin: "expired",
      profiles: [
        authProfile("openai:expired", { status: "expired" }),
        authProfile("openai:first"),
        authProfile("openai:key", { type: "api_key", status: "static" }),
      ],
      expected: "Sign-in needed",
    },
    { pin: "missing", profiles: [authProfile("openai:first")], expected: "Sign-in needed" },
  ])(
    "keeps $expected in options, not triggers, through Auto refresh",
    async ({ pin, plan, profiles, expected }) => {
      const { context, request } = createHarness("main");
      const original = request.getMockImplementation()!;
      const suffix = pin ? "@openai:" + pin : "";
      const config = {
        agents: { defaults: { model: { primary: "openai/prepared-primary" + suffix } } },
      };
      request.mockImplementation((method, params?: { refresh?: boolean }) => {
        if (method === "models.authStatus") {
          return Promise.resolve(
            createAuthStatus([
              {
                profiles,
                ...(plan ? { usage: { providerId: "openai", windows: [], plan } } : {}),
              },
            ]),
          );
        }
        if (method === "config.get") {
          return Promise.resolve({ config, hash: "model-defaults" });
        }
        if (method === "models.list") {
          return Promise.resolve({
            ...preparedCatalog,
            defaultModels: {
              automaticUtilityModel:
                "openai/prepared-" + (params?.refresh ? "fallback" : "utility") + suffix,
            },
          });
        }
        return original(method);
      });
      const page = appendPage(context);
      await waitForProviders(page, config);
      await drainPageUpdates(page);
      const primary = modelPicker(page, "primary");
      const utility = modelPicker(page, "utility");
      function expectTrigger(picker: Element, label: string) {
        const trigger = picker.querySelector(".picker-select__trigger")!;
        expectContent(trigger, [label]);
        expectAbsent(trigger, ".picker-select__description");
        expect(trigger.getAttribute("aria-label")).not.toContain(expected);
      }
      expectTrigger(primary, "Prepared primary");
      expectTrigger(utility, "Auto · Prepared utility");
      await openModelPicker(page, "primary");
      expect(
        primary.querySelector(
          option("openai/prepared-primary" + suffix) + " .picker-select__description",
        )?.textContent,
      ).toBe(expected);
      await openModelPicker(page, "utility");
      expectContent(utility.querySelector(option("__openclaw_automatic_utility__")), [expected]);
      click(page, 'button[aria-label="Refresh"]');
      await waitForSolid(() =>
        expect(displayedCatalog(page)?.defaultModels?.automaticUtilityModel).toBe(
          "openai/prepared-fallback" + suffix,
        ),
      );
      await drainPageUpdates(page);
      expectTrigger(utility, "Auto · Prepared fallback");
      expectContent(utility.querySelector(option("__openclaw_automatic_utility__")), [expected]);
    },
  );

  it("keeps one actionable warning when failure publishes after the Retry reply", async () => {
    const h = createCatalogHarness(preparedCatalog);
    const pending = deferred<ModelCatalogResult>();
    const failed: ModelCatalogResult = {
      ...preparedCatalog,
      refreshFailed: true,
      providerOutcomes: [{ provider: "openai", status: "unavailable" }],
    };
    h.readPublished.mockReturnValue(failed);
    h.discover
      .mockRejectedValueOnce(new Error("discovery failed"))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        ...recovered(),
        providerOutcomes: [{ provider: "openai", status: "ready" }],
      });
    const page = await h.mount();
    const picker = modelPicker(page, "primary");
    expectContent(page.querySelector('[data-provider-id="openai"]'), ["Models unavailable"]);
    await retryCatalog(page);
    await waitForText(page, warning + " span", "discovery failed");
    const publication = deferred<ModelCatalogResult>();
    let publicationStarted = false;
    h.request.mockImplementation((method, params?: { refresh?: boolean }) => {
      if (method !== "models.list" || params?.refresh) {
        return h.catalogRequest(method, params);
      }
      publicationStarted = true;
      return publication.promise;
    });
    await retryCatalog(page);
    expectPresent(page, pendingProgress);
    expectAbsent(page, warning);
    expect(modelPicker(page, "primary")).toBe(picker);
    pending.resolve(failed);
    await waitForSolid(() => expectPresent(page, warning));
    h.announce();
    await waitForSolid(() => expect(publicationStarted).toBe(true));
    expect(page.querySelectorAll(warning)).toHaveLength(1);
    publication.resolve(failed);
    await drainPageUpdates(page);
    expect(page.querySelectorAll(warning)).toHaveLength(1);
    expectContent(page.querySelector(warning), ["More models could not be discovered."]);
    expectAbsent(page, ".model-providers__provider-list .provider-usage__error");
    await openModelPicker(page);
    expectPresent(page, option("openai/prepared-primary"));
    await retryCatalog(page);
    await expectCatalog(page, recovered());
    expectAbsent(page, progress);
    expect(modelPicker(page, "primary")).toBe(picker);
    expectPresent(page, option("openai/recovered"));
    expectContent(
      page.querySelector('[data-provider-id="openai"]'),
      ["Ready"],
      ["Models unavailable"],
    );
  });

  it("keeps pickers request-free and saved choices stable through full and empty partial publication", async () => {
    const h = createCatalogHarness();
    h.readPublished.mockReturnValue({ ...preparedCatalog, pendingProviders: ["openai"] });
    const page = await h.mount();
    await page.updateComplete;
    const reads = requestCount(h.request, "models.list");
    await openModelPicker(page, "utility");
    await drainPageUpdates(page);
    expect(requestCount(h.request, "models.list")).toBe(reads);
    expect(h.discover).not.toHaveBeenCalled();
    expectPresent(page, pendingProgress);
    expect(page.querySelector<HTMLButtonElement>(progress + " button")?.disabled).toBe(false);
    expect(
      chatModelPickers(page).map(
        (picker) => picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled,
      ),
    ).toEqual([false, false, false]);

    const full = {
      ...recovered("discovered"),
      decisionModels: preparedCatalog.decisionModels,
      models: [
        ...recovered("discovered").models,
        ...["a", "b", "c", "d", "e"].map((id) => catalogModel(id, id)),
      ],
    };
    h.readPublished.mockReturnValue(full);
    h.announce();
    await expectCatalog(page, full);
    expectAbsent(page, progress);
    await expectSavedChoices(page);
    for (const picker of chatModelPickers(page)) {
      expectPresent(picker, option("openai/discovered"));
      expectAbsent(picker, option("typesafe/jev-latest"));
    }
    await openPicker(modelPicker(page, "decision"));
    expect(modelPicker(page, "decision").querySelector(selected)?.getAttribute("data-value")).toBe(
      "typesafe/jev-latest",
    );
    expectAbsent(modelPicker(page, "decision"), option("openai/discovered"));

    const later = {
      ...full,
      models: [...full.models, catalogModel("published-later", "Published later")],
    };
    h.readPublished.mockReturnValue(later);
    await openModelPicker(page, "utility");
    await drainPageUpdates(page);
    expect(displayedCatalog(page)?.models).toEqual(full.models);
    h.announce();
    await expectCatalog(page, later);
    expectPresent(page, option("openai/published-later"));
    const utility = modelPicker(page, "utility");
    const search = utility.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "Discovered";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await utility.updateComplete;
    expect(
      [...utility.querySelectorAll<HTMLElement>('[role="option"]:not([hidden])')].map(
        (entry) => entry.dataset.value,
      ),
    ).toEqual(["openai/discovered"]);
    expectContent(utility.querySelector(".picker-select__trigger"), ["Prepared utility"]);

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await utility.updateComplete;

    h.readPublished.mockReturnValue({
      models: [],
      refreshFailed: true,
      pendingProviders: ["openai"],
    });
    h.announce("config.changed");
    await waitForText(page, warning, "More models could not be discovered.");
    expectPresent(page, pendingProgress);
    await expectSavedChoices(page);
    await openModelPicker(page, "decision");
    expect(
      modelPicker(page, "decision")
        .querySelector(option("typesafe/jev-latest"))
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expectContent(page.querySelector(progress + " button"), ["Retry"]);
    expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
    expect(h.runtimeConfig.patch).not.toHaveBeenCalled();
    expect(h.discover).not.toHaveBeenCalled();
  });

  it.each(["page refresh", "agent switch"] as const)(
    "retires a rejected catalog error on %s",
    async (replacement) => {
      const h = createCatalogHarness(preparedCatalog);
      const pending = deferred<ModelCatalogResult>();
      h.readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      h.discover
        .mockRejectedValueOnce(new Error("Previous catalog request failed"))
        .mockReturnValueOnce(pending.promise);
      const page = await h.mount();
      const picker = modelPicker(page, "primary");
      await retryCatalog(page);
      await waitForText(page, warning, "Previous catalog request failed");
      await drainPageUpdates(page);
      const feedback = page.querySelector(".model-providers__catalog-feedback");
      h.readPublished.mockReturnValue(preparedCatalog);
      h.request.mockImplementation((method, params?: { refresh?: boolean; agentId?: string }) =>
        method === "models.list" && params?.agentId === "writer"
          ? pending.promise
          : h.catalogRequest(method, params),
      );
      if (replacement === "page refresh") {
        click(page, 'button[aria-label="Refresh"]');
      } else {
        h.settingsAgentSelection.state.selectedId = "writer";
        h.settingsAgentSelection.state.scopeId = "writer";
        h.notifySelection();
      }
      await waitForSolid(() => {
        expect(requestCount(h.request, "models.list")).toBe(3);
        expectContent(
          page.querySelector(".model-providers__catalog-feedback"),
          [],
          ["Previous catalog request failed"],
        );
      });
      if (replacement === "page refresh") {
        expect(page.querySelector(".model-providers__catalog-feedback")).toBe(feedback);
        expect(modelPicker(page, "primary")).toBe(picker);
      }
      pending.resolve(recovered("replacement-recovered"));
      await expectCatalog(page, recovered("replacement-recovered"));
      expectAbsent(page, warning);
      if (replacement === "page refresh") {
        expect(modelPicker(page, "primary")).toBe(picker);
      } else {
        expect(page.view.props.credentialAgentLabel).toBe("Writer");
      }
      await openModelPicker(page);
      expectPresent(page, option("openai/replacement-recovered"));
    },
  );

  it("keeps a new Retry active when a retired Retry rejects", async () => {
    const h = createCatalogHarness(preparedCatalog);
    h.readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
    const retired = deferred<ModelCatalogResult>();
    const current = deferred<ModelCatalogResult>();
    h.discover.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const page = await h.mount();
    await retryCatalog(page);
    replaceRoute(page, "Catalog unavailable");
    await waitForText(page, warning, "Catalog unavailable");
    await retryCatalog(page);
    retired.reject(new Error("Retired discovery failed"));
    await drainPageUpdates(page);
    expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
    expectPresent(page, pendingProgress);
    expectAbsent(page, warning);
    await openModelPicker(page, "fallback");
    current.resolve(recovered("current"));
    await expectCatalog(page, recovered("current"));
    expectPresent(page, option("openai/current"));
    expectAbsent(page, progress);
  });

  it("keeps a saved auth-owner order on every alias route", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    publishRouteData(page, {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      updatedAt: 1,
      authStatus: createAuthStatus([
        ...["claude-cli", "anthropic"].map((provider) => ({
          provider,
          authProvider: "anthropic",
          displayName: "Claude",
          profiles: ["one", "two"].map((id) => authProfile("claude:" + id)),
          profileOrder: ["claude:one", "claude:two"],
        })),
        { profileOrder: ["openai:one", "openai:two"] },
      ]),
    });
    const unrelated = structuredClone(page.view.props.authStatus?.providers[2]);
    page.view.props.onProfileOrderChange("anthropic", "anthropic", ["claude:two", "claude:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(page.view.props.profileOrders.anthropic).toBeUndefined());
    expect(
      page.view.props.authStatus?.providers.map(({ provider, profileOrder }) => ({
        provider,
        profileOrder,
      })),
    ).toEqual([
      { provider: "claude-cli", profileOrder: ["claude:two", "claude:one"] },
      { provider: "anthropic", profileOrder: ["claude:two", "claude:one"] },
      { provider: "openai", profileOrder: ["openai:one", "openai:two"] },
    ]);
    expect(page.view.props.authStatus?.providers[2]).toEqual(unrelated);
  });

  it("keeps a saved profile order when an older refresh finishes afterward", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const original = request.getMockImplementation()!;
    const stale = deferred<unknown>();
    const authStatus = createAuthStatus([{ profileOrder: ["openai:one", "openai:two"] }]);
    const refreshed = createAuthStatus([{ profileOrder: ["openai:two", "openai:one"] }], 2);
    publishRouteData(page, { ...EMPTY_MODEL_PROVIDERS_DATA, authStatus, updatedAt: 1 });
    let reads = 0;
    request.mockImplementation(async (method) => {
      if (method === "models.authStatus") {
        return ++reads === 1 ? stale.promise : refreshed;
      }
      return method === "models.authOrderSet" ? {} : original(method);
    });
    page.view.props.onRefresh();
    await vi.waitFor(() => expect(reads).toBe(1));
    page.view.props.onProfileOrderChange("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() => expect(page.view.props.profileOrders.openai).toBeUndefined());
    expect(page.view.props.authStatus?.providers[0]?.profileOrder).toEqual([
      "openai:two",
      "openai:one",
    ]);
    stale.resolve(authStatus);
    await drainPageUpdates(page);
    expect(page.view.props.authStatus?.providers[0]?.profileOrder).toEqual([
      "openai:two",
      "openai:one",
    ]);
  });
});
