/* @vitest-environment jsdom */

import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult, ModelCatalogResult } from "../../api/types.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function modelPickers(page: Element): SelectPicker[] {
  return [
    ...page.querySelectorAll<SelectPicker>(".model-providers__defaults openclaw-select-picker"),
  ];
}

async function openModelPicker(page: HTMLElement, index = 0): Promise<void> {
  await updatePickers(page);
  const picker = modelPickers(page)[index];
  expect(picker).toBeDefined();
  const trigger = picker!.querySelector<HTMLButtonElement>(".picker-select__trigger");
  expect(trigger).not.toBeNull();
  if (trigger!.getAttribute("aria-expanded") === "true") {
    trigger!.click();
    await picker!.updateComplete;
  }
  trigger!.click();
  await picker!.updateComplete;
}

async function drainPageUpdates(page: ModelProvidersPageTestElement): Promise<void> {
  // Drain every promise continuation before checking that a retired result stayed absent.
  await setImmediate();
  await page.updateComplete;
  await updatePickers(page);
}

const preparedCatalog: ModelCatalogResult = {
  models: [
    { id: "prepared-primary", name: "Prepared primary", provider: "openai", available: true },
    { id: "prepared-utility", name: "Prepared utility", provider: "openai", available: true },
    { id: "prepared-fallback", name: "Prepared fallback", provider: "openai", available: true },
  ],
};

const savedModelConfig = {
  agents: {
    defaults: {
      model: {
        primary: "openai/prepared-primary",
        fallbacks: ["openai/prepared-fallback"],
      },
      utilityModel: "openai/prepared-utility",
    },
  },
};

function createCatalogHarness() {
  const harness = createHarness("main");
  const originalRequest = harness.request.getMockImplementation()!;
  const discover = vi.fn<() => Promise<ModelCatalogResult>>();
  const readPublished = vi.fn(() => preparedCatalog);
  const catalogRequest = async (
    method: string,
    params?: { refresh?: boolean; preparedOnly?: boolean },
  ) => {
    if (method === "models.list") {
      return params?.preparedOnly
        ? preparedCatalog
        : params?.refresh
          ? discover()
          : readPublished();
    }
    if (method === "config.get") {
      return { config: savedModelConfig, hash: "saved-model-config" };
    }
    return originalRequest(method);
  };
  harness.request.mockImplementation(catalogRequest);
  return { ...harness, discover, readPublished, catalogRequest };
}

describe("ModelProvidersPage catalog discovery", () => {
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
    "shows $expected beside saved defaults and the resolved Auto model",
    async ({ profile, plan, profiles, expected }) => {
      const { context, request } = createHarness("main");
      const originalRequest = request.getMockImplementation()!;
      const suffix = profile ? `@${profile}` : "";
      const config = {
        agents: { defaults: { model: { primary: `openai/prepared-primary${suffix}` } } },
      };
      request.mockImplementation(
        (method: string, params?: { includeDefaultModels?: boolean; refresh?: boolean }) => {
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
              ...(params?.includeDefaultModels
                ? {
                    defaultModels: {
                      automaticUtilityModel: `openai/${params.refresh ? "prepared-fallback" : "prepared-utility"}${suffix}`,
                    },
                  }
                : {}),
            });
          }
          return originalRequest(method);
        },
      );
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(config));
      await drainPageUpdates(page);

      const primary = modelPickers(page)[0]!;
      const utility = modelPickers(page)[1]!;
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

      await openModelPicker(page, 1);
      await waitForFast(() =>
        expect(page.data?.automaticUtilityModel).toBe(`openai/prepared-fallback${suffix}`),
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

    await waitForFast(() => expect(page.data?.models).toEqual(published.models));
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
      agentSelection,
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
    await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
    await waitForFast(() => expect(authSignal).toBeDefined());
    publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });

    agentSelection.state.selectedId = "writer";
    agentSelection.state.scopeId = "writer";
    notifySelection();
    expect(authSignal!.aborted).toBe(true);
    authRefresh.resolve(createAuthStatus());

    await waitForFast(() => expect(page.data?.models).toEqual(writerModels));
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

      await waitForFast(() => expect(page.data?.models).toEqual(current.models));
      await page.updateComplete;
      expect(page.textContent).not.toContain("Not configured");
      expect(page.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
        "unsaved-key-draft",
      );
      expect(discover).not.toHaveBeenCalled();
    },
  );

  it.each(["before", "after"])(
    "keeps one actionable catalog warning when failure publishes %s the picker reply",
    async (publicationTiming) => {
      const { context, discover, readPublished, publishEvent } = createCatalogHarness();
      const pending = deferred<ModelCatalogResult>();
      const failed = { ...preparedCatalog, refreshFailed: true };
      discover.mockReturnValueOnce(pending.promise).mockResolvedValue({
        models: [
          ...preparedCatalog.models,
          { id: "recovered", name: "Recovered model", provider: "openai", available: true },
        ],
      });
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await openModelPicker(page);
      expect(discover).toHaveBeenCalledOnce();
      if (publicationTiming === "after") {
        pending.resolve(failed);
        await waitForFast(() =>
          expect(
            page.querySelector('.model-providers__catalog-progress[role="alert"]'),
          ).not.toBeNull(),
        );
      }

      readPublished.mockReturnValue(failed);
      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForFast(() => expect(page.data?.catalogError).not.toBeNull());
      if (publicationTiming === "before") {
        pending.resolve(failed);
      }
      await drainPageUpdates(page);

      const warnings = page.querySelectorAll('.model-providers__catalog-progress[role="alert"]');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.textContent).toContain("More models could not be discovered.");
      expect(
        page.querySelector(".model-providers__provider-list .provider-usage-error"),
      ).toBeNull();
      expect(page.data?.models).toEqual(preparedCatalog.models);
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(
        page.querySelector('[role="option"][data-value="openai/prepared-primary"]'),
      ).not.toBeNull();
      const retry = warnings[0]!.querySelector<HTMLButtonElement>("button");
      expect(retry?.textContent?.trim()).toBe("Retry");

      retry!.click();

      await waitForFast(() => expect(page.data?.models?.at(-1)?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(discover).toHaveBeenCalledTimes(2);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
      expect(page.data?.catalogError).toBeNull();
    },
  );

  it.each([false, true])(
    "shows a catalog refresh failure without changing saved choices (retained rows: %s)",
    async (hasRows) => {
      const { context, discover, request, runtimeConfig } = createCatalogHarness();
      const models = hasRows ? preparedCatalog.models : [];
      discover.mockResolvedValue({ models, refreshFailed: true });
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;

      await openModelPicker(page);
      const warning = "More models could not be discovered.";
      await waitForFast(() =>
        expect(page.querySelector(".model-providers__catalog-progress")?.textContent).toContain(
          warning,
        ),
      );
      await drainPageUpdates(page);
      expect(page.data?.models).toEqual(models);
      expect(page.textContent).toContain(warning);
      expect(page.data?.catalogError).toBeNull();
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
        [
          "models.list",
          { agentId: "main", view: "configured", includeDefaultModels: true },
          expect.anything(),
        ],
        [
          "models.list",
          { agentId: "main", view: "configured", includeDefaultModels: true, refresh: true },
          expect.anything(),
        ],
      ]);
    },
  );

  it.each([
    { picker: "primary", index: 0 },
    { picker: "utility", index: 1 },
    { picker: "fallback", index: 2 },
  ])(
    "discovers the full catalog when the $picker picker opens and merges it without clearing saved state",
    async ({ index: firstPicker }) => {
      const { context, request, discover, readPublished, runtimeConfig, publishEvent } =
        createCatalogHarness();
      const pending = deferred<ModelCatalogResult>();
      discover.mockReturnValue(pending.promise);
      const discovered: ModelCatalogResult = {
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
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      expect(discover).not.toHaveBeenCalled();
      expect(page.data?.models).toEqual(preparedCatalog.models);
      expect(modelPickers(page)).toHaveLength(3);

      await openModelPicker(page, firstPicker);
      expect(discover).toHaveBeenCalledOnce();

      for (const index of [0, 1, 2, 0]) {
        await openModelPicker(page, index);
      }
      await page.updateComplete;
      expect(discover).toHaveBeenCalledOnce();
      const progress = page.querySelector(".model-providers__catalog-progress");
      expect(progress?.getAttribute("role")).toBe("status");
      expect(progress?.textContent).toContain("Discovering more models");
      expect(
        modelPickers(page).map(
          (picker) => picker.querySelector<HTMLButtonElement>(".picker-select__trigger")?.disabled,
        ),
      ).toEqual([false, false, false]);
      expect(page.data?.models).toEqual(preparedCatalog.models);

      pending.resolve(discovered);
      await waitForFast(() => expect(page.data?.models).toEqual(discovered.models));
      await drainPageUpdates(page);

      for (const picker of modelPickers(page)) {
        expect(
          picker.querySelector('[role="option"][data-value="openai/discovered"]'),
        ).not.toBeNull();
      }
      expect(
        modelPickers(page).map((picker) =>
          picker.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
        ),
      ).toEqual(["openai/prepared-primary", "openai/prepared-utility", "openai/prepared-fallback"]);
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      const published = {
        models: [
          ...discovered.models,
          { id: "published-later", name: "Published later", provider: "openai", available: true },
        ],
      };
      readPublished.mockReturnValue(published);
      await openModelPicker(page, 1);
      await drainPageUpdates(page);
      expect(page.data?.models).toEqual(discovered.models);
      expect(readPublished).toHaveBeenCalledOnce();
      publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
      await waitForFast(() => expect(page.data?.models).toEqual(published.models));
      await drainPageUpdates(page);
      expect(
        page.querySelector('[role="option"][data-value="openai/published-later"]'),
      ).not.toBeNull();
      const utility = modelPickers(page)[1]!;
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
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(discover).toHaveBeenCalledOnce();
      expect(readPublished).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(3);
    },
  );

  it.each(["rejected request", "nonfatal refresh failure"])(
    "retains choices and reacquires on Retry after a %s",
    async (failure) => {
      const { context, discover } = createCatalogHarness();
      const pending = deferred<ModelCatalogResult>();
      if (failure === "rejected request") {
        discover.mockRejectedValueOnce(new Error("discovery failed"));
      } else {
        discover.mockResolvedValueOnce({ ...preparedCatalog, refreshFailed: true });
      }
      discover.mockReturnValueOnce(pending.promise);
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;

      await openModelPicker(page);
      await waitForFast(() =>
        expect(
          page.querySelector('.model-providers__catalog-progress[role="alert"]'),
        ).not.toBeNull(),
      );
      expect(page.querySelector(".model-providers__catalog-progress")?.textContent).toContain(
        "More models could not be discovered.",
      );
      expect(page.textContent).not.toContain("Open Models to try again.");
      expect(page.data?.models).toEqual(preparedCatalog.models);
      const retry = page.querySelector<HTMLButtonElement>(
        ".model-providers__catalog-progress button",
      );
      expect(retry?.textContent?.trim()).toBe("Retry");
      retry!.click();
      await page.updateComplete;
      expect(discover).toHaveBeenCalledTimes(2);
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();

      pending.resolve({
        models: [
          ...preparedCatalog.models,
          { id: "recovered", name: "Recovered model", provider: "openai", available: true },
        ],
      });
      await waitForFast(() => expect(page.data?.models?.at(-1)?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/recovered"]')).not.toBeNull();
      expect(page.data?.catalogError).toBeNull();
    },
  );

  it.each([false, true])(
    "clears a prior catalog error after successful discovery (unrelated auth error: %s)",
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
            ...preparedCatalog.models,
            { id: "recovered", name: "Recovered model", provider: "openai", available: true },
          ],
        });
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;

      page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      await waitForFast(() =>
        expect(page.data?.catalogError).toContain("Initial catalog unavailable"),
      );
      await page.updateComplete;
      expect(page.data?.models).toEqual(preparedCatalog.models);
      await openModelPicker(page);

      await waitForFast(() => expect(page.data?.models?.at(-1)?.id).toBe("recovered"));
      await drainPageUpdates(page);
      expect(page.data?.catalogError).toBeNull();
      expect(page.data?.error).toBe(authFails ? "Credential status unavailable" : null);
      expect(page.textContent).not.toContain("Initial catalog unavailable");
      if (authFails) {
        expect(page.textContent).toContain("Credential status unavailable");
      }
    },
  );

  it.each([
    { replacement: "core refresh", catalogRequests: 3, discoveries: 3, publicationReads: 1 },
    { replacement: "route data", catalogRequests: 2, discoveries: 2, publicationReads: 1 },
    { replacement: "config.changed", catalogRequests: 3, discoveries: 1, publicationReads: 2 },
    {
      replacement: "chat.metadata.changed",
      catalogRequests: 3,
      discoveries: 1,
      publicationReads: 2,
    },
  ])(
    "keeps newer $replacement after an older picker response settles",
    async ({ replacement, catalogRequests, discoveries, publicationReads }) => {
      const { context, request, discover, readPublished, snapshot, publishEvent } =
        createCatalogHarness();
      const pending = deferred<ModelCatalogResult>();
      const newer: ModelCatalogResult = {
        models: [{ id: "newer", name: "Newer model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "ready" }],
      };
      discover.mockReturnValueOnce(pending.promise).mockResolvedValue(newer);
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      await openModelPicker(page);
      expect(discover).toHaveBeenCalledOnce();

      // Page replacement retires its request; publication also retires the shared cache.
      if (replacement === "core refresh") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      } else if (replacement === "route data") {
        page.routeData = {
          gateway: context.gateway,
          gatewaySnapshot: snapshot,
          client: snapshot.client,
          agentId: "main",
          data: {
            ...EMPTY_MODEL_PROVIDERS_DATA,
            config: savedModelConfig,
            models: newer.models,
            providerOutcomes: newer.providerOutcomes!,
            updatedAt: 2,
          },
        };
      } else {
        readPublished.mockReturnValue(newer);
        publishEvent({ type: "event", event: replacement, payload: {} });
      }
      await waitForFast(() => expect(page.data?.models).toEqual(newer.models));

      pending.resolve({
        models: [{ id: "retired", name: "Retired model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "unavailable" }],
      });
      await drainPageUpdates(page);

      expect(page.data?.models).toEqual(newer.models);
      expect(page.data?.providerOutcomes).toEqual(newer.providerOutcomes);
      expect(page.querySelector('[role="option"][data-value="openai/newer"]')).not.toBeNull();
      expect(page.querySelector('[role="option"][data-value="openai/retired"]')).toBeNull();
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(
        catalogRequests,
      );
      readPublished.mockReturnValue(newer);
      await openModelPicker(page, 1);
      await drainPageUpdates(page);
      expect(discover).toHaveBeenCalledTimes(discoveries);
      expect(readPublished).toHaveBeenCalledTimes(publicationReads);
      expect(page.data?.models).toEqual(newer.models);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps replacement discovery active when retired discovery completes with %s",
    async (completion) => {
      const { context, discover, snapshot } = createCatalogHarness();
      const retired = deferred<ModelCatalogResult>();
      const current = deferred<ModelCatalogResult>();
      discover.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      await openModelPicker(page);
      expect(discover).toHaveBeenCalledOnce();

      page.routeData = {
        gateway: context.gateway,
        gatewaySnapshot: snapshot,
        client: snapshot.client,
        agentId: "main",
        data: {
          ...EMPTY_MODEL_PROVIDERS_DATA,
          config: savedModelConfig,
          models: preparedCatalog.models,
          updatedAt: 2,
        },
      };
      await page.updateComplete;
      await openModelPicker(page, 1);
      await page.updateComplete;
      expect(discover).toHaveBeenCalledTimes(2);

      if (completion === "resolve") {
        retired.resolve({ models: [{ id: "retired", name: "Retired", provider: "openai" }] });
      } else {
        retired.reject(new Error("Retired discovery failed"));
      }
      await drainPageUpdates(page);

      expect(page.data?.models).toEqual(preparedCatalog.models);
      expect(
        page.querySelector('.model-providers__catalog-progress[role="status"]'),
      ).not.toBeNull();
      expect(page.querySelector('.model-providers__catalog-progress[role="alert"]')).toBeNull();
      await openModelPicker(page, 2);
      expect(discover).toHaveBeenCalledTimes(2);
      current.resolve({
        models: [{ id: "current", name: "Current model", provider: "openai", available: true }],
      });
      await waitForFast(() => expect(page.data?.models?.[0]?.id).toBe("current"));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
    },
  );

  it("keeps discovery alive when another page retires its own request", async () => {
    const { context, discover, snapshot } = createCatalogHarness();
    const pending = deferred<ModelCatalogResult>();
    discover.mockReturnValue(pending.promise);
    const first = appendPage(context);
    const second = appendPage(context);
    await waitForFast(() => expect(first.data?.config).toEqual(savedModelConfig));
    await waitForFast(() => expect(second.data?.config).toEqual(savedModelConfig));
    await first.updateComplete;
    await second.updateComplete;
    await openModelPicker(first);
    await openModelPicker(second);
    expect(discover).toHaveBeenCalledTimes(2);
    first.routeData = {
      gateway: context.gateway,
      gatewaySnapshot: snapshot,
      client: snapshot.client,
      agentId: "main",
      data: {
        ...EMPTY_MODEL_PROVIDERS_DATA,
        config: savedModelConfig,
        models: preparedCatalog.models,
        updatedAt: 2,
      },
    };
    await first.updateComplete;
    pending.resolve({
      models: [{ id: "shared", name: "Shared discovery", provider: "openai", available: true }],
    });
    await waitForFast(() => expect(second.data?.models?.[0]?.id).toBe("shared"));
    await drainPageUpdates(first);
    await drainPageUpdates(second);

    expect(first.data?.models).toEqual(preparedCatalog.models);
    expect(second.querySelector('[role="option"][data-value="openai/shared"]')).not.toBeNull();
    expect(first.querySelector(".model-providers__catalog-progress")).toBeNull();
    expect(second.querySelector(".model-providers__catalog-progress")).toBeNull();
    expect(discover).toHaveBeenCalledTimes(2);
  });
});
