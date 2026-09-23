/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult, ModelCatalogResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { invalidateModelCatalogCache } from "../../lib/model-catalog-cache.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
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
  waitForProviders,
} from "./model-providers-page.test-support.ts";

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
  it("disables defaults without showing an admin warning when config patches are unavailable", async () => {
    const { context, runtimeConfig } = createHarness("main");
    vi.spyOn(runtimeConfig, "canPatch", "get").mockReturnValue(false);
    const page = appendPage(context);
    await waitForProviders(page);
    await updatePickers(page);
    const defaults = page.querySelector(".model-providers__defaults");

    expect(
      [
        ...(defaults?.querySelectorAll("openclaw-select-picker button, wa-radio-group") ?? []),
      ].every((control) => control.hasAttribute("disabled")),
    ).toBe(true);
    expect(page.textContent).not.toContain("operator.admin access");
  });
  it.each([
    {
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
      ],
      expected: "Subscription · first@example.com",
    },
    {
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
        { profileId: "openai:second", type: "oauth", status: "ok", email: "second@example.com" },
      ],
      expected: "Subscription",
    },
    {
      profile: "openai:second",
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
        { profileId: "openai:second", type: "oauth", status: "ok", email: "second@example.com" },
      ],
      expected: "Subscription · second@example.com",
    },
    {
      profiles: [{ profileId: "openai:key", type: "api_key", status: "static" }],
      expected: "API",
    },
    {
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
        { profileId: "openai:key", type: "api_key", status: "static" },
      ],
      expected: "API / Subscription",
    },
    {
      profile: "openai:key",
      profiles: [
        { profileId: "openai:first", type: "oauth", status: "ok", email: "first@example.com" },
        { profileId: "openai:key", type: "api_key", status: "static" },
      ],
      expected: "API",
    },
    {
      profiles: [
        {
          profileId: "openai:expired",
          type: "oauth",
          status: "expired",
          email: "expired@example.com",
        },
        { profileId: "openai:key", type: "api_key", status: "static" },
      ],
      expected: "API",
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
      await waitForFast(() =>
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
    await waitForFast(() => expect(page.textContent).toContain("Not configured"));
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
    await waitForFast(() => expect(authSignal).toBeDefined());
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
    expect(authSignal!.aborted).toBe(false);
    expect(discover).not.toHaveBeenCalled();
    authRefresh.resolve(originalAuth);
    await waitForFast(() => expect(discover).toHaveBeenCalledOnce());
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

    await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(published.models));
    await drainPageUpdates(page);
    expect(authSignal!.aborted).toBe(false);
    expect(discover).toHaveBeenCalledOnce();
    expect(readPublished).toHaveBeenCalledTimes(2);
    expect(page.textContent).not.toContain("Not configured");
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
    await waitForFast(() => expect(authSignal).toBeDefined());
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });

    settingsAgentSelection.state.selectedId = "writer";
    settingsAgentSelection.state.scopeId = "writer";
    notifySelection();
    expect(authSignal!.aborted).toBe(true);
    authRefresh.resolve(createAuthStatus());

    await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(writerModels));
    await drainPageUpdates(page);
    expect(discover).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(2);
    expect(page.querySelector('[role="option"][data-value="openai/writer"]')).not.toBeNull();
  });

  it.each(["config.changed", "chat.metadata.changed"])(
    "updates credential and catalog facts on %s without clearing a key draft",
    async (event) => {
      const { context, request, publishEvent, readPublished, discover, catalogRequest } =
        createCatalogHarness();
      let auth = createAuthStatus([{ status: "missing", profiles: [] }]);
      request.mockImplementation((method: string, params?: { refresh?: boolean }) =>
        method === "models.authStatus" ? Promise.resolve(auth) : catalogRequest(method, params),
      );
      const page = appendPage(context);
      await waitForFast(() => expect(page.textContent).toContain("Not configured"));
      const editKey = [
        ...page.querySelectorAll<HTMLButtonElement>(".model-providers__card-actions button"),
      ].find((button) => button.textContent?.trim() === "Set API key");
      expect(editKey).toBeDefined();
      editKey!.click();
      await page.updateComplete;
      const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
      input.value = "unsaved-key-draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      auth = createAuthStatus([{ status: "static", profiles: [], apiKey: { source: "config" } }]);
      const current = {
        models: [{ id: "new", name: "New model", provider: "openai", available: true }],
      };
      readPublished.mockReturnValue(current);

      publishEvent({ type: "event", event, payload: {} });

      await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(current.models));
      await page.updateComplete;
      expect(page.textContent).not.toContain("Not configured");
      expect(page.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
        "unsaved-key-draft",
      );
      expect(discover).not.toHaveBeenCalled();
    },
  );

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
        await waitForFast(() =>
          expect(
            page.querySelector('.model-providers__catalog-progress[role="alert"]'),
          ).not.toBeNull(),
        );
      }

      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      if (publicationTiming === "before") {
        pending.resolve(failed);
      }
      await waitForFast(() => expect(publicationStarted).toBe(true));
      await drainPageUpdates(page);
      expect(page.data?.catalogError).toBeNull();
      expect(
        page.querySelectorAll('.model-providers__catalog-progress[role="alert"]'),
      ).toHaveLength(1);
      expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
      publication.resolve(failed);
      await waitForFast(() => expect(page.data?.catalogError).not.toBeNull());
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

      await waitForFast(() => expect(displayedCatalog(page)?.models?.at(-1)?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
      expect(page.data?.catalogError).toBeNull();
    },
  );

  it.each(["Refresh", "Retry"] as const)(
    "Models page completes explicit %s before reading a publication that arrives during it",
    async (action) => {
      const { context, discover, readPublished, publishEvent, deferNextAuthStatus } =
        createCatalogHarness(preparedCatalog);
      readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);
      const pending = deferred<ModelCatalogResult>();
      discover.mockReturnValue(pending.promise);
      const releaseAuth = action === "Refresh" ? deferNextAuthStatus() : undefined;
      if (action === "Refresh") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      } else {
        await retryCatalog(page);
      }
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
      releaseAuth?.();
      await waitForFast(() => expect(discover).toHaveBeenCalledOnce());
      pending.resolve({
        models: [{ id: "refreshed", name: "Refreshed model", provider: "openai", available: true }],
      });
      await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(published.models));
      await drainPageUpdates(page);
      expect(discover).toHaveBeenCalledOnce();
      expect(readPublished).toHaveBeenCalledTimes(2);
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
    },
  );

  it.each(["primary", "utility", "fallback", "decision"] as const)(
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
      await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(published.models));
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
      await waitForFast(() =>
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
        [...utility.querySelectorAll<HTMLElement>('[role="option"]')].map(
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

  it.each([false, true])(
    "Models page adopts current partial inventory without changing saved choices (returned rows: %s)",
    async (hasRows) => {
      const { context, discover, readPublished, runtimeConfig, publishEvent } =
        createCatalogHarness();
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);
      const models = hasRows
        ? [{ provider: "openai", id: "current", name: "Current returned model", available: true }]
        : [];
      readPublished.mockReturnValue({ models, refreshFailed: true });

      publishEvent({ type: "event", event: "config.changed", payload: {} });
      await waitForFast(() =>
        expect(
          page.querySelector('.model-providers__catalog-progress[role="alert"]')?.textContent,
        ).toContain("More models could not be discovered."),
      );
      await openModelPicker(page);
      expect(displayedCatalog(page)?.models).toEqual(models);
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
      expect(
        page.querySelector(".model-providers__catalog-progress button")?.textContent,
      ).toContain("Retry");
    },
  );

  it.each(["rejected request", "nonfatal refresh failure"])(
    "Models page Retry retains choices after a %s and displays the recovered catalog",
    async (failure) => {
      const { context, discover, readPublished, runtimeConfig } =
        createCatalogHarness(preparedCatalog);
      readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      const pending = deferred<ModelCatalogResult>();
      if (failure === "rejected request") {
        discover.mockRejectedValueOnce(new Error("discovery failed"));
      } else {
        discover.mockResolvedValueOnce({ ...preparedCatalog, refreshFailed: true });
      }
      discover.mockReturnValueOnce(pending.promise);
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);

      await retryCatalog(page);
      await waitForFast(() =>
        expect(
          page.querySelector('.model-providers__catalog-progress[role="alert"]'),
        ).not.toBeNull(),
      );
      expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
      await retryCatalog(page);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      await openModelPicker(page);
      expect(discover).toHaveBeenCalledTimes(2);
      pending.resolve({
        models: [
          ...preparedCatalog.models,
          { id: "recovered", name: "Recovered model", provider: "openai", available: true },
        ],
      });
      await waitForFast(() => expect(displayedCatalog(page)?.models?.at(-1)?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
      expect(page.data?.catalogError).toBeNull();
      expect(currentConfigObject(page.context.runtimeConfig.state)).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "Models page Retry clears a catalog error without hiding unrelated auth errors (auth fails: %s)",
    async (authFails) => {
      const { context, discover, request, catalogRequest } = createCatalogHarness();
      request.mockImplementation(async (method: string, params?: { refresh?: boolean }) => {
        if (method === "models.authStatus" && authFails) {
          throw new Error("Credential status unavailable");
        }
        return catalogRequest(method, params);
      });
      discover
        .mockRejectedValueOnce(new Error("Initial catalog unavailable"))
        .mockResolvedValueOnce({
          models: [
            { id: "recovered", name: "Recovered model", provider: "openai", available: true },
          ],
        });
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);
      await page.updateComplete;

      page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await waitForFast(() =>
        expect(page.data?.catalogError).toContain("Initial catalog unavailable"),
      );
      await retryCatalog(page);
      await waitForFast(() => expect(displayedCatalog(page)?.models?.[0]?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(page.data?.catalogError).toBeNull();
      expect(page.textContent).not.toContain("Initial catalog unavailable");
      expect(page.data?.error).toBe(authFails ? "Credential status unavailable" : null);
      if (authFails) {
        expect(page.textContent).toContain("Credential status unavailable");
      }
    },
  );

  it.each(["completed", "pending"] as const)(
    "Models page keeps newer Retry %s when an older Refresh completes",
    async (discoveryState) => {
      const { context, request, discover, readPublished, catalogRequest, runtimeConfig } =
        createCatalogHarness({
          ...preparedCatalog,
          defaultModels: { automaticUtilityModel: "openai/prepared-utility" },
        });
      const refreshedConfig = {
        agents: {
          defaults: {
            model: {
              ...savedModelConfig.agents.defaults.model,
              primary: "openai/prepared-utility",
            },
          },
        },
      };
      const coreConfig = deferred<{ config: typeof refreshedConfig; hash: string }>();
      const coreCatalog = deferred<ModelCatalogResult>();
      const pickerDiscovery = deferred<ModelCatalogResult>();
      readPublished.mockReturnValue({
        ...preparedCatalog,
        refreshFailed: true,
        defaultModels: { automaticUtilityModel: "openai/prepared-utility" },
      });
      const newer: ModelCatalogResult = {
        models: [
          ...preparedCatalog.models,
          { id: "newer", name: "Newer model", provider: "openai", available: true },
        ],
        defaultModels: { automaticUtilityModel: "openai/newer" },
        providerOutcomes: [{ provider: "openai", status: "ready" }],
        pendingProviders: [],
      };
      discover
        .mockReturnValueOnce(coreCatalog.promise)
        .mockReturnValueOnce(pickerDiscovery.promise);
      const page = appendPage(context);
      try {
        await waitForProviders(page, savedModelConfig);
        await drainPageUpdates(page);
        expect(displayedCatalog(page)?.defaultModels?.automaticUtilityModel).toBe(
          "openai/prepared-utility",
        );
        let configRequested = false;
        request.mockImplementation((method: string, params?: { refresh?: boolean }) => {
          if (method === "config.get") {
            configRequested = true;
            return coreConfig.promise;
          }
          return catalogRequest(method, params);
        });

        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
        await waitForFast(() => {
          expect(configRequested).toBe(true);
          expect(discover).toHaveBeenCalledOnce();
        });
        await drainPageUpdates(page);
        expect(
          modelPicker(page, "primary").querySelector<HTMLButtonElement>(".picker-select__trigger")
            ?.disabled,
        ).toBe(false);
        await openModelPicker(page);
        expect(discover).toHaveBeenCalledOnce();
        await retryCatalog(page);
        expect(discover).toHaveBeenCalledOnce();
        coreCatalog.resolve({
          ...preparedCatalog,
          defaultModels: { automaticUtilityModel: "openai/prepared-fallback" },
          pendingProviders: ["stale-provider"],
        });
        await waitForFast(() => expect(discover).toHaveBeenCalledTimes(2));
        if (discoveryState === "completed") {
          pickerDiscovery.resolve(newer);
          await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(newer.models));
          await drainPageUpdates(page);
          expect(page.querySelector('[role="option"][data-value="openai/newer"]')).not.toBeNull();
        }

        await drainPageUpdates(page);
        coreConfig.resolve({ config: refreshedConfig, hash: "refreshed-model-config" });
        await waitForProviders(page, refreshedConfig);
        await drainPageUpdates(page);
        expect(displayedCatalog(page)?.defaultModels?.automaticUtilityModel).toBe(
          discoveryState === "completed" ? "openai/newer" : "openai/prepared-utility",
        );
        expect(
          page.querySelector("#model-providers-utility-model .picker-select__label")?.textContent,
        ).toBe(discoveryState === "completed" ? "Auto · Newer model" : "Auto · Prepared utility");
        expect(
          modelPicker(page, "primary")
            ?.querySelector('[role="option"][aria-selected="true"]')
            ?.getAttribute("data-value"),
        ).toBe("openai/prepared-utility");
        if (discoveryState === "pending") {
          expect(
            page.querySelector('.model-providers__catalog-progress[role="status"]'),
          ).not.toBeNull();
          pickerDiscovery.resolve(newer);
          await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(newer.models));
          await drainPageUpdates(page);
        }
        expect(page.querySelector('[role="option"][data-value="openai/newer"]')).not.toBeNull();
        expect(displayedCatalog(page)?.defaultModels?.automaticUtilityModel).toBe("openai/newer");
        expect(
          page.querySelector("#model-providers-utility-model .picker-select__label")?.textContent,
        ).toBe("Auto · Newer model");
        expect(page.data?.providerOutcomes).toEqual(newer.providerOutcomes);
        expect(displayedCatalog(page)?.pendingProviders).toEqual(newer.pendingProviders);
        expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
        expect(runtimeConfig.patch).not.toHaveBeenCalled();
      } finally {
        coreCatalog.resolve(preparedCatalog);
        coreConfig.resolve({ config: refreshedConfig, hash: "refreshed-model-config" });
        pickerDiscovery.resolve(newer);
        page.remove();
      }
    },
  );

  it.each([
    { replacement: "Refresh button", catalogRequests: 3, discoveries: 2, publicationReads: 1 },
    { replacement: "route data", catalogRequests: 2, discoveries: 1, publicationReads: 1 },
    { replacement: "config.changed", catalogRequests: 3, discoveries: 1, publicationReads: 2 },
    {
      replacement: "chat.metadata.changed",
      catalogRequests: 3,
      discoveries: 1,
      publicationReads: 2,
    },
  ])(
    "Models page retains newer $replacement data after an older Retry settles",
    async ({ replacement, catalogRequests, discoveries, publicationReads }) => {
      const { context, request, discover, readPublished, snapshot, publishEvent } =
        createCatalogHarness(preparedCatalog);
      readPublished.mockReturnValue({ ...preparedCatalog, refreshFailed: true });
      const pending = deferred<ModelCatalogResult>();
      const newer: ModelCatalogResult = {
        models: [{ id: "newer", name: "Newer model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "ready" }],
      };
      discover.mockReturnValueOnce(pending.promise).mockResolvedValue(newer);
      const page = appendPage(context);
      await waitForProviders(page, savedModelConfig);
      await retryCatalog(page);

      if (replacement === "Refresh button") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      } else if (replacement === "route data") {
        publishCatalog(context, "main", newer);
        page.routeData = {
          ...createEmptyModelProvidersRouteData(context),
          gatewaySnapshot: snapshot,
          client: snapshot.client,
          data: {
            ...EMPTY_MODEL_PROVIDERS_DATA,
            providerOutcomes: newer.providerOutcomes!,
            updatedAt: 2,
          },
        };
        await page.updateComplete;
      } else {
        readPublished.mockReturnValue(newer);
        publishEvent({ type: "event", event: replacement, payload: {} });
      }
      if (replacement === "route data") {
        await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(newer.models));
      } else if (replacement === "Refresh button") {
        await drainPageUpdates(page);
        expect(discover).toHaveBeenCalledOnce();
        expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
      }
      pending.resolve({
        models: [{ id: "retired", name: "Retired model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "unavailable" }],
      });
      await waitForFast(() => expect(displayedCatalog(page)?.models).toEqual(newer.models));
      await drainPageUpdates(page);
      expect(displayedCatalog(page)?.models).toEqual(newer.models);
      expect(page.data?.providerOutcomes).toEqual(newer.providerOutcomes);
      expect(page.querySelector('[role="option"][data-value="openai/newer"]')).not.toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/retired"]')).toBeNull();
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(
        catalogRequests,
      );
      readPublished.mockReturnValue(newer);
      await openModelPicker(page, "utility");
      await drainPageUpdates(page);
      expect(discover).toHaveBeenCalledTimes(discoveries);
      expect(readPublished).toHaveBeenCalledTimes(publicationReads);
      expect(displayedCatalog(page)?.models).toEqual(newer.models);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "Models page keeps its new Retry active when a retired Retry completes with %s",
    async (completion) => {
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

      if (completion === "resolve") {
        retired.resolve({ models: [{ id: "retired", name: "Retired", provider: "openai" }] });
      } else {
        retired.reject(new Error("Retired discovery failed"));
      }
      await drainPageUpdates(page);
      expect(displayedCatalog(page)?.models).toEqual(preparedCatalog.models);
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      expect(page.querySelector('.model-providers__catalog-progress[role="alert"]')).toBeNull();
      await openModelPicker(page, "fallback");
      expect(discover).toHaveBeenCalledTimes(2);
      current.resolve({
        models: [{ id: "current", name: "Current model", provider: "openai", available: true }],
      });
      await waitForFast(() => expect(displayedCatalog(page)?.models?.[0]?.id).toBe("current"));
      await drainPageUpdates(page);
      expect(page.querySelector('[role="option"][data-value="openai/current"]')).not.toBeNull();
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
    },
  );

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
    expect(first.selectedAgentId).toBe("main");
    expect(second.selectedAgentId).toBe("writer");
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
    await waitForFast(() => expect(displayedCatalog(second)?.models?.[0]?.id).toBe("shared"));
    await drainPageUpdates(first);
    await drainPageUpdates(second);
    expect(displayedCatalog(first)?.models).toEqual(preparedCatalog.models);
    expect(second.querySelector('[role="option"][data-value="openai/shared"]')).not.toBeNull();
    expect(first.querySelector('[role="option"][data-value="openai/shared"]')).toBeNull();
    expect(first.querySelector(".model-providers__catalog-progress")).toBeNull();
    expect(second.querySelector(".model-providers__catalog-progress")).toBeNull();
  });
});
