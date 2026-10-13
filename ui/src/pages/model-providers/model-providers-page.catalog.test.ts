/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult, ModelCatalogResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
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
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const preparedCatalog: ModelCatalogResult = {
  models: [
    { id: "prepared-primary", name: "Prepared primary", provider: "openai", available: true },
    { id: "prepared-utility", name: "Prepared utility", provider: "openai", available: true },
    { id: "prepared-fallback", name: "Prepared fallback", provider: "openai", available: true },
  ],
  decisionModels: [{ id: "jev-latest", name: "Jev", provider: "typesafe", pluginId: "typesafe" }],
};

const savedModelConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/prepared-primary",
        fallbacks: ["openai/prepared-fallback"],
      },
      utilityModel: "openai/prepared-utility",
      decisionModel: "typesafe/jev-latest",
    },
  },
};

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
  return { ...harness, discover, readPublished, catalogRequest };
}

describe("Models page catalog publication", () => {
  it.each([
    {
      profile: "openai:second",
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
        { profileId: "openai:second", type: "oauth", status: "ok", email: "second@example.com" },
      ],
      expected: "Subscription · second@example.com",
    },
    {
      profiles: [
        {
          profileId: "openai:expired",
          type: "oauth",
          status: "expired",
          email: "expired@example.com",
        },
        {
          profileId: "openai:first",
          type: "oauth",
          status: "expiring",
          email: "first@example.com",
        },
      ],
      plan: "Other account plan",
      expected: "Subscription · first@example.com",
    },
    {
      profile: "openai:expired",
      profiles: [
        {
          profileId: "openai:expired",
          type: "oauth",
          status: "expired",
          email: "expired@example.com",
        },
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
        { profileId: "openai:key", type: "api_key", status: "static" },
      ],
      expected: "Sign-in needed",
    },
    {
      profile: "openai:missing",
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
      ],
      expected: "Sign-in needed",
    },
  ] satisfies Array<{
    profile?: string;
    plan?: string;
    profiles: ModelAuthStatusResult["providers"][number]["profiles"];
    expected: string;
  }>)(
    "Models page shows $expected beside saved defaults and refreshes the resolved Auto model",
    async ({ profile, plan, profiles, expected }) => {
      const { context, request } = createHarness("main");
      const originalRequest = request.getMockImplementation()!;
      const suffix = profile ? `@${profile}` : "";
      const config = {
        agents: { defaults: { model: { primary: `openai/prepared-primary${suffix}` } } },
      };
      request.mockImplementation((method: string, params?: { refresh?: boolean }) => {
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
              automaticUtilityModel: `openai/${params?.refresh ? "prepared-fallback" : "prepared-utility"}${suffix}`,
            },
          });
        }
        return originalRequest(method);
      });
      const page = appendPage(context);
      await waitForProviders(page, config);
      await drainPageUpdates(page);

      const primary = modelPicker(page, "primary");
      const utility = modelPicker(page, "utility");
      const primaryTrigger = primary.querySelector(".picker-select__trigger")!;
      const utilityTrigger = utility.querySelector(".picker-select__trigger")!;
      expect(primaryTrigger.textContent).toContain("Prepared primary");
      expect(primaryTrigger.querySelector(".picker-select__description")?.textContent).toBe(
        expected,
      );
      expect(utilityTrigger.textContent).toContain("Auto · Prepared utility");
      expect(utilityTrigger.querySelector(".picker-select__description")?.textContent).toBe(
        expected,
      );
      expect(utilityTrigger.getAttribute("aria-label")).toContain(expected);
      expect(
        utility.querySelector('[role="option"][data-value="__openclaw_automatic_utility__"]')
          ?.textContent,
      ).toContain(expected);

      const requestsBeforeOpen = request.mock.calls.length;
      await openModelPicker(page, "utility");
      await drainPageUpdates(page);
      expect(request).toHaveBeenCalledTimes(requestsBeforeOpen);
      page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await waitForSolid(() =>
        expect(displayedCatalog(page)?.defaultModels?.automaticUtilityModel).toBe(
          `openai/prepared-fallback${suffix}`,
        ),
      );
      await drainPageUpdates(page);
      expect(utilityTrigger.textContent).toContain("Auto · Prepared fallback");
      expect(utilityTrigger.querySelector(".picker-select__description")?.textContent).toBe(
        expected,
      );
    },
  );

  it("finishes explicit acquisition before reading publication queued during auth refresh", async () => {
    const { context, request, publishEvent, readPublished, discover, catalogRequest } =
      createCatalogHarness();
    const authRefresh = deferred<ModelAuthStatusResult>();
    const catalogRefresh = deferred<ModelCatalogResult>();
    const originalAuth = createAuthStatus([{ status: "missing", profiles: [] }]);
    let publishedAuth = originalAuth;
    let authSignal: AbortSignal | undefined;
    request.mockImplementation(
      (method: string, params?: { refresh?: boolean }, options?: { signal?: AbortSignal }) => {
        if (method === "models.authStatus") {
          if (params?.refresh) {
            authSignal = options?.signal;
            return authRefresh.promise;
          }
          return Promise.resolve(publishedAuth);
        }
        return catalogRequest(method, params);
      },
    );
    discover.mockReturnValue(catalogRefresh.promise);
    const page = appendPage(context);
    await waitForSolid(() => expect(page.renderRoot.textContent).toContain("Not configured"));
    const editKey = [
      ...page.querySelectorAll<HTMLButtonElement>(".model-providers__card-actions button"),
    ].find((button) => button.textContent?.trim() === "Set API key");
    expect(editKey).toBeDefined();
    editKey!.click();
    await page.updateComplete;
    const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = "unsaved-key-draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await waitForSolid(() => expect(authSignal).toBeDefined());
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
    expect(authSignal!.aborted).toBe(false);
    expect(discover).not.toHaveBeenCalled();
    authRefresh.resolve(originalAuth);
    await waitForSolid(() => expect(discover).toHaveBeenCalledOnce());
    const published = {
      models: [{ id: "published", name: "Published model", provider: "openai", available: true }],
    };
    readPublished.mockReturnValue(published);
    publishedAuth = createAuthStatus([
      { status: "static", profiles: [], apiKey: { source: "config" } },
    ]);
    publishEvent({ type: "event", event: "config.changed", payload: {} });
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
    catalogRefresh.resolve(preparedCatalog);

    await waitForSolid(() => expect(displayedCatalog(page)?.models).toEqual(published.models));
    await drainPageUpdates(page);
    expect(authSignal!.aborted).toBe(false);
    expect(discover).toHaveBeenCalledOnce();
    expect(readPublished).toHaveBeenCalledTimes(2);
    expect(page.renderRoot.textContent).not.toContain("Not configured");
    expect(page.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
      "unsaved-key-draft",
    );
    expect(page.querySelector('[role="option"][data-value="openai/published"]')).not.toBeNull();
  });

  it("retires an old agent's queued publication when selection changes during auth refresh", async () => {
    const {
      context,
      request,
      publishEvent,
      discover,
      catalogRequest,
      settingsAgentSelection,
      notifySelection,
    } = createCatalogHarness();
    const authRefresh = deferred<ModelAuthStatusResult>();
    let authSignal: AbortSignal | undefined;
    const writerModels = [
      { id: "writer", name: "Writer model", provider: "openai", available: true },
    ];
    request.mockImplementation(
      (
        method: string,
        params?: { refresh?: boolean; agentId?: string },
        options?: { signal?: AbortSignal },
      ) => {
        if (method === "models.authStatus" && params?.refresh) {
          authSignal = options?.signal;
          return authRefresh.promise;
        }
        if (method === "models.list" && params?.agentId === "writer") {
          return Promise.resolve({ models: writerModels });
        }
        return catalogRequest(method, params);
      },
    );
    const page = appendPage(context);
    await waitForProviders(page, savedModelConfig);
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await waitForSolid(() => expect(authSignal).toBeDefined());
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });

    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    expect(authSignal!.aborted).toBe(true);
    authRefresh.resolve(createAuthStatus());

    await waitForSolid(() => expect(displayedCatalog(page)?.models).toEqual(writerModels));
    await drainPageUpdates(page);
    expect(discover).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(2);
    expect(page.querySelector('[role="option"][data-value="openai/writer"]')).not.toBeNull();
  });

  it.each(["before", "after"])(
    "keeps one actionable catalog warning when failure publishes %s the Retry reply",
    async (publicationTiming) => {
      const { context, request, discover, readPublished, publishEvent, catalogRequest } =
        createCatalogHarness(preparedCatalog);
      const pending = deferred<ModelCatalogResult>();
      const failed = { ...preparedCatalog, refreshFailed: true };
      readPublished.mockReturnValue(failed);
      discover.mockReturnValueOnce(pending.promise).mockResolvedValue({
        models: [
          ...preparedCatalog.models,
          { id: "recovered", name: "Recovered model", provider: "openai", available: true },
        ],
      });
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);
      const publication = deferred<ModelCatalogResult>();
      let publicationStarted = false;
      request.mockImplementation((method: string, params?: { refresh?: boolean }) => {
        if (method === "models.list" && !params?.refresh) {
          publicationStarted = true;
          return publication.promise;
        }
        return catalogRequest(method, params);
      });
      await retryCatalog(page);
      expect(discover).toHaveBeenCalledOnce();
      if (publicationTiming === "after") {
        pending.resolve(failed);
        await waitForSolid(() =>
          expect(
            page.querySelector('.model-providers__catalog-progress[role="alert"]'),
          ).not.toBeNull(),
        );
      }

      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      if (publicationTiming === "before") {
        pending.resolve(failed);
      }
      await waitForSolid(() => expect(publicationStarted).toBe(true));
      await drainPageUpdates(page);
      expect(page.state.data?.catalogError).toBeNull();
      expect(
        page.querySelectorAll('.model-providers__catalog-progress[role="alert"]'),
      ).toHaveLength(1);
      expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
      publication.resolve(failed);
      await waitForSolid(() => expect(page.state.data?.catalogError).not.toBeNull());
      await drainPageUpdates(page);

      const warnings = page.querySelectorAll('.model-providers__catalog-progress[role="alert"]');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.textContent).toContain("More models could not be discovered.");
      expect(
        page.querySelector(".model-providers__provider-list .provider-usage-error"),
      ).toBeNull();
      expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
      expect(
        page.querySelector('[role="option"][data-value="openai/prepared-primary"]'),
      ).not.toBeNull();
      const retry = warnings[0]!.querySelector<HTMLButtonElement>("button");
      expect(retry?.textContent?.trim()).toBe("Retry");

      retry!.click();

      await waitForSolid(() =>
        expect(displayedCatalog(page)?.models?.at(-1)?.id).toBe("recovered"),
      );
      await drainPageUpdates(page);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
      expect(page.state.data?.catalogError).toBeNull();
    },
  );

  it("Models page completes explicit Refresh before reading a publication that arrives during it", async () => {
    const { context, discover, readPublished, publishEvent, deferNextAuthStatus } =
      createCatalogHarness(preparedCatalog);
    readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
    const page = appendPage(context);
    await waitForProviders(page, savedModelConfig);
    const pending = deferred<ModelCatalogResult>();
    discover.mockReturnValue(pending.promise);
    const releaseAuth = deferNextAuthStatus();

    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();

    const published: ModelCatalogResult = {
      models: [{ id: "published", name: "Published model", provider: "openai", available: true }],
    };
    readPublished.mockReturnValue(published);
    for (const event of ["chat.metadata.changed", "config.changed", "chat.metadata.changed"]) {
      publishEvent({ type: "event", event, payload: {} });
    }
    await drainPageUpdates(page);
    expect(readPublished).toHaveBeenCalledTimes(1);
    expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
    releaseAuth();
    await waitForSolid(() => expect(discover).toHaveBeenCalledOnce());
    pending.resolve({
      models: [{ id: "refreshed", name: "Refreshed model", provider: "openai", available: true }],
    });
    await waitForSolid(() => expect(displayedCatalog(page)?.models).toEqual(published.models));
    await drainPageUpdates(page);
    expect(discover).toHaveBeenCalledOnce();
    expect(readPublished).toHaveBeenCalledTimes(2);
    expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
  });

  it.each(["utility", "decision"] as const)(
    "Models page %s picker opens without a request and preserves saved choices as publication completes",
    async (role) => {
      const { context, request, discover, readPublished, runtimeConfig, publishEvent } =
        createCatalogHarness();
      readPublished.mockReturnValue({ ...preparedCatalog, pendingProviders: ["openai"] });
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);
      await page.updateComplete;
      const requestsAfterLoad = request.mock.calls.filter(([method]) => method === "models.list");
      expect(requestsAfterLoad).toHaveLength(1);

      await openModelPicker(page, role);
      await drainPageUpdates(page);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual(
        requestsAfterLoad,
      );
      expect(discover).not.toHaveBeenCalled();
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      expect(
        chatModelPickers(page).map(
          (picker) => picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled,
        ),
      ).toEqual([false, false, false]);

      const published: ModelCatalogResult = {
        ...preparedCatalog,
        models: [
          ...preparedCatalog.models,
          { id: "discovered", name: "Discovered model", provider: "openai", available: true },
          ...[
            "alternative-a",
            "alternative-b",
            "alternative-c",
            "alternative-d",
            "alternative-e",
          ].map((id) => ({ id, name: id, provider: "openai", available: true })),
        ],
      };
      readPublished.mockReturnValue(published);
      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForSolid(() => expect(displayedCatalog(page)?.models).toEqual(published.models));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      for (const picker of chatModelPickers(page)) {
        expect(
          picker.querySelector('[role="option"][data-value="openai/discovered"]'),
        ).not.toBeNull();
        expect(
          picker.querySelector('[role="option"][data-value="typesafe/jev-latest"]'),
        ).toBeNull();
      }
      const decision = modelPicker(page, "decision");
      expect(
        decision.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
      ).toBe("typesafe/jev-latest");
      expect(decision.querySelector('[role="option"][data-value="openai/discovered"]')).toBeNull();
      expect(
        chatModelPickers(page).map((picker) =>
          picker.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
        ),
      ).toEqual(["openai/prepared-primary", "openai/prepared-utility", "openai/prepared-fallback"]);
      const laterPublication: ModelCatalogResult = {
        ...published,
        models: [
          ...published.models,
          { id: "published-later", name: "Published later", provider: "openai", available: true },
        ],
      };
      readPublished.mockReturnValue(laterPublication);
      await openModelPicker(page, "utility");
      await drainPageUpdates(page);
      expect(displayedCatalog(page)?.models).toEqual(published.models);
      expect(readPublished).toHaveBeenCalledTimes(2);
      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForSolid(() =>
        expect(displayedCatalog(page)?.models).toEqual(laterPublication.models),
      );
      await drainPageUpdates(page);
      expect(
        page.querySelector('[role="option"][data-value="openai/published-later"]'),
      ).not.toBeNull();
      const utility = modelPicker(page, "utility");
      const search = utility.querySelector<HTMLInputElement>('input[type="search"]');
      expect(search).not.toBeNull();
      search!.value = "Discovered";
      search!.dispatchEvent(new Event("input", { bubbles: true }));
      await utility.updateComplete;
      expect(
        [...utility.querySelectorAll<HTMLElement>('[role="option"]:not([hidden])')].map(
          (option) => option.dataset.value,
        ),
      ).toEqual(["openai/discovered"]);
      expect(utility.querySelector(".picker-select__trigger")?.textContent).toContain(
        "Prepared utility",
      );
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(3);
      expect(readPublished).toHaveBeenCalledTimes(3);
    },
  );

  it("Models page adopts an empty partial inventory without changing saved choices", async () => {
    const { context, discover, readPublished, runtimeConfig, publishEvent } =
      createCatalogHarness();
    const page = appendPage(context);
    await waitForProviders(page, savedModelConfig);
    readPublished.mockReturnValue({ models: [], refreshFailed: true });

    publishEvent({ type: "event", event: "config.changed", payload: {} });
    await waitForSolid(() =>
      expect(
        page.querySelector('.model-providers__catalog-progress[role="alert"]')?.textContent,
      ).toContain("More models could not be discovered."),
    );
    await openModelPicker(page);
    expect(displayedCatalog(page)?.models).toEqual([]);
    expect(
      chatModelPickers(page).map((picker) =>
        picker.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
      ),
    ).toEqual(["openai/prepared-primary", "openai/prepared-utility", "openai/prepared-fallback"]);
    expect(
      modelPicker(page, "decision")
        .querySelector('[role="option"][data-value="typesafe/jev-latest"]')
        ?.getAttribute("aria-disabled"),
    ).toBe("true");
    expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
    expect(page.querySelector(".model-providers__catalog-progress button")?.textContent).toContain(
      "Retry",
    );
  });

  it("Models page Retry retains choices after a rejected request and displays the recovered catalog", async () => {
    const { context, discover, readPublished, runtimeConfig } =
      createCatalogHarness(preparedCatalog);
    readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
    const pending = deferred<ModelCatalogResult>();

    discover.mockRejectedValueOnce(new Error("discovery failed"));

    discover.mockReturnValueOnce(pending.promise);
    const page = appendPage(context);
    await waitForProviders(page, savedModelConfig);

    await retryCatalog(page);
    await waitForSolid(() =>
      expect(
        page.querySelector('.model-providers__catalog-progress[role="alert"] span')?.textContent,
      ).toBe("discovery failed"),
    );
    expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
    await retryCatalog(page);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(page.querySelector('.model-providers__catalog-progress[role="status"]')).not.toBeNull();
    await openModelPicker(page);
    expect(discover).toHaveBeenCalledTimes(2);
    pending.resolve({
      models: [
        ...preparedCatalog.models,
        { id: "recovered", name: "Recovered model", provider: "openai", available: true },
      ],
    });
    await waitForSolid(() => expect(displayedCatalog(page)?.models?.at(-1)?.id).toBe("recovered"));
    await drainPageUpdates(page);
    expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
    expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
    expect(page.state.data?.catalogError).toBeNull();
    expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("Models page keeps its new Retry active when a retired Retry completes with reject", async () => {
    const { context, discover, readPublished, snapshot } = createCatalogHarness(preparedCatalog);
    readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
    const retired = deferred<ModelCatalogResult>();
    const current = deferred<ModelCatalogResult>();
    discover.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const page = appendPage(context);
    await waitForProviders(page, savedModelConfig);
    await retryCatalog(page);
    publishCatalog(context, "main", preparedCatalog);
    page.routeData = {
      ...createEmptyModelProvidersRouteData(context),
      gatewaySnapshot: snapshot,
      client: snapshot.client,
      data: {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        catalogError: "Catalog unavailable",
        updatedAt: 2,
      },
    };
    await page.updateComplete;
    await retryCatalog(page);

    retired.reject(new Error("Retired discovery failed"));

    await drainPageUpdates(page);
    expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
    expect(page.querySelector('.model-providers__catalog-progress[role="status"]')).not.toBeNull();
    expect(page.querySelector('.model-providers__catalog-progress[role="alert"]')).toBeNull();
    await openModelPicker(page, "fallback");
    expect(discover).toHaveBeenCalledTimes(2);
    current.resolve({
      models: [{ id: "current", name: "Current model", provider: "openai", available: true }],
    });
    await waitForSolid(() => expect(displayedCatalog(page)?.models?.[0]?.id).toBe("current"));
    await drainPageUpdates(page);
    expect(page.querySelector('[role="option"][data-value="openai/current"]')).not.toBeNull();
    expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
  });

  it("Models page for another agent keeps its Retry alive when the first page retires its request", async () => {
    const { context, discover, readPublished, snapshot } = createCatalogHarness(preparedCatalog);
    readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
    const writer = createHarness("writer");
    const pending = deferred<ModelCatalogResult>();
    discover.mockReturnValue(pending.promise);
    const first = appendPage(context);
    const second = appendPage({
      ...context,
      settingsAgentSelection: writer.context.settingsAgentSelection,
    });
    await waitForProviders(first, savedModelConfig);
    await waitForProviders(second, savedModelConfig);
    await retryCatalog(first);
    await retryCatalog(second);
    expect(first.state.selectedAgentId).toBe("main");
    expect(second.state.selectedAgentId).toBe("writer");
    publishCatalog(context, "main", preparedCatalog);
    first.routeData = {
      ...createEmptyModelProvidersRouteData(context),
      gatewaySnapshot: snapshot,
      client: snapshot.client,
      data: {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        updatedAt: 2,
      },
    };
    await first.updateComplete;

    pending.resolve({
      models: [{ id: "shared", name: "Shared discovery", provider: "openai", available: true }],
    });
    await waitForSolid(() => expect(displayedCatalog(second)?.models?.[0]?.id).toBe("shared"));
    await drainPageUpdates(first);
    await drainPageUpdates(second);
    expect(displayedCatalog(first)?.models).toEqual(preparedCatalog.models);
    expect(second.querySelector('[role="option"][data-value="openai/shared"]')).not.toBeNull();
    expect(first.querySelector('[role="option"][data-value="openai/shared"]')).toBeNull();
    expect(first.querySelector(".model-providers__catalog-progress")).toBeNull();
    expect(second.querySelector(".model-providers__catalog-progress")).toBeNull();
  });
  it("keeps a saved auth-owner order on every alias route", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    page.setState("data", {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      authStatus: createAuthStatus([
        ...["claude-cli", "anthropic"].map((provider) => ({
          provider,
          authProvider: "anthropic",
          displayName: "Claude",
          profiles: [
            { profileId: "claude:one", type: "oauth" as const, status: "ok" as const },
            { profileId: "claude:two", type: "oauth" as const, status: "ok" as const },
          ],
          profileOrder: ["claude:one", "claude:two"],
        })),
        { profileOrder: ["openai:one", "openai:two"] },
      ]),
      updatedAt: 1,
    });
    const unrelatedProvider = structuredClone(page.state.data?.authStatus?.providers[2]);

    page.profileActions.setOrder("anthropic", "anthropic", ["claude:two", "claude:one"]);

    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(page.state.profileOrders.anthropic).toBeUndefined());
    expect(
      page.state.data?.authStatus?.providers.map(({ provider, profileOrder }) => ({
        provider,
        profileOrder,
      })),
    ).toEqual([
      { provider: "claude-cli", profileOrder: ["claude:two", "claude:one"] },
      { provider: "anthropic", profileOrder: ["claude:two", "claude:one"] },
      { provider: "openai", profileOrder: ["openai:one", "openai:two"] },
    ]);
    expect(page.state.data?.authStatus?.providers[2]).toEqual(unrelatedProvider);
  });

  it("keeps a saved profile order when an older refresh finishes afterward", async () => {
    const { context, request } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const originalRequest = request.getMockImplementation()!;
    const staleStatus = deferred<unknown>();
    const authStatus = createAuthStatus([
      {
        profileOrder: ["openai:one", "openai:two"],
      },
    ]);
    const refreshedStatus = {
      ...authStatus,
      ts: 2,
      providers: [
        {
          ...authStatus.providers[0],
          profileOrder: ["openai:two", "openai:one"],
        },
      ],
    };
    page.setState("data", {
      ...EMPTY_MODEL_PROVIDERS_DATA,
      authStatus,
      updatedAt: 1,
    });
    request.mockClear();
    let authStatusCalls = 0;
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authStatus") {
        authStatusCalls += 1;
        return authStatusCalls === 1 ? staleStatus.promise : refreshedStatus;
      }
      if (method === "models.authOrderSet") {
        return {};
      }
      void params;
      return originalRequest(method);
    });

    const refreshing = page.refresh("forced");
    await vi.waitFor(() => expect(requestCount(request, "models.authStatus")).toBe(1));
    page.profileActions.setOrder("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    await vi.waitFor(() => expect(authStatusCalls).toBe(2));
    await vi.waitFor(() => expect(page.state.profileOrders.openai).toBeUndefined());
    expect(page.state.data?.authStatus?.providers[0]?.profileOrder).toEqual([
      "openai:two",
      "openai:one",
    ]);

    staleStatus.resolve(authStatus);
    await refreshing;

    expect(page.state.data?.authStatus?.providers[0]?.profileOrder).toEqual([
      "openai:two",
      "openai:one",
    ]);
  });
});
