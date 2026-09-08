/* @vitest-environment jsdom */

import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogResult } from "../../api/types.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  createHarness,
  deferred,
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
  const readCatalog = vi.fn<() => Promise<ModelCatalogResult>>().mockResolvedValue(preparedCatalog);
  const catalogRequest = async (method: string, _params?: unknown) => {
    if (method === "models.list") {
      return readCatalog();
    }
    if (method === "config.get") {
      return { config: savedModelConfig, hash: "saved-model-config" };
    }
    return originalRequest(method);
  };
  harness.request.mockImplementation(catalogRequest);
  return { ...harness, readCatalog, catalogRequest };
}

describe("ModelProvidersPage catalog discovery", () => {
  it.each([false, true])(
    "shows a published catalog failure without changing saved choices (retained rows: %s)",
    async (hasRows) => {
      const { context, readCatalog, runtimeConfig } = createCatalogHarness();
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      const models = hasRows ? preparedCatalog.models : [];
      readCatalog.mockResolvedValue({ models, refreshFailed: true });

      await openModelPicker(page);
      const warning = hasRows
        ? "Some models could not be refreshed. Open Models to try again."
        : "Models unavailable";
      await waitForFast(() => expect(page.data?.catalogError).toBe(warning));
      await drainPageUpdates(page);
      expect(page.data?.models).toEqual(models);
      expect(page.textContent).toContain(warning);
      expect(page.data?.config).toEqual(savedModelConfig);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
    },
  );

  it.each([
    { picker: "primary", index: 0 },
    { picker: "utility", index: 1 },
    { picker: "fallback", index: 2 },
  ])(
    "reads published catalog choices when the $picker picker opens without changing saved state",
    async ({ index: firstPicker }) => {
      const { context, request, readCatalog, runtimeConfig } = createCatalogHarness();
      const pending = deferred<ModelCatalogResult>();
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
      readCatalog.mockClear();
      readCatalog.mockReturnValueOnce(pending.promise).mockResolvedValue(discovered);
      expect(readCatalog).not.toHaveBeenCalled();
      expect(page.data?.models).toEqual(preparedCatalog.models);
      expect(modelPickers(page)).toHaveLength(3);

      await openModelPicker(page, firstPicker);
      expect(readCatalog).toHaveBeenCalledOnce();

      for (const index of [0, 1, 2, 0]) {
        await openModelPicker(page, index);
      }
      await page.updateComplete;
      expect(readCatalog).toHaveBeenCalledOnce();
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
      await openModelPicker(page, 1);
      await drainPageUpdates(page);
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
      expect(readCatalog).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
        ["models.list", { agentId: "main", view: "configured" }, expect.anything()],
        ["models.list", { agentId: "main", view: "configured" }, expect.anything()],
        ["models.list", { agentId: "main", view: "configured" }, expect.anything()],
      ]);
    },
  );

  it("surfaces a retryable error when picker catalog discovery fails", async () => {
    const { context, readCatalog } = createCatalogHarness();
    const pending = deferred<ModelCatalogResult>();
    const page = appendPage(context);
    await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
    await page.updateComplete;
    readCatalog.mockClear();
    readCatalog
      .mockRejectedValueOnce(new Error("discovery failed"))
      .mockReturnValueOnce(pending.promise);

    await openModelPicker(page);
    await waitForFast(() =>
      expect(page.querySelector('.model-providers__catalog-progress[role="alert"]')).not.toBeNull(),
    );
    expect(page.querySelector(".model-providers__catalog-progress")?.textContent).toContain(
      "More models could not be discovered.",
    );
    expect(page.data?.models).toEqual(preparedCatalog.models);
    const retry = page.querySelector<HTMLButtonElement>(
      ".model-providers__catalog-progress button",
    );
    expect(retry?.textContent?.trim()).toBe("Retry");
    retry!.click();
    await page.updateComplete;
    expect(readCatalog).toHaveBeenCalledTimes(2);
    expect(page.querySelector('.model-providers__catalog-progress[role="status"]')).not.toBeNull();

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
  });

  it.each([false, true])(
    "clears a prior catalog error after successful discovery (unrelated auth error: %s)",
    async (authFails) => {
      const { context, readCatalog, request, catalogRequest } = createCatalogHarness();
      request.mockImplementation(async (method: string, params?: { refresh?: boolean }) => {
        if (method === "models.authStatus" && authFails) {
          throw new Error("Credential status unavailable");
        }
        return catalogRequest(method, params);
      });
      const recovered = {
        models: [
          ...preparedCatalog.models,
          { id: "recovered", name: "Recovered model", provider: "openai", available: true },
        ],
      };
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      readCatalog.mockClear();
      readCatalog
        .mockRejectedValueOnce(new Error("Initial catalog unavailable"))
        .mockResolvedValueOnce(preparedCatalog)
        .mockResolvedValueOnce(recovered);

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

  it.each(["core refresh", "route data"] as const)(
    "keeps newer %s after an older picker response settles",
    async (replacement) => {
      const { context, request, readCatalog, snapshot } = createCatalogHarness();
      const pending = deferred<ModelCatalogResult>();
      const newer: ModelCatalogResult = {
        models: [{ id: "newer", name: "Newer model", provider: "openai", available: true }],
        providerOutcomes: [{ provider: "openai", status: "ready" }],
      };
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      readCatalog.mockClear();
      readCatalog.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(newer);
      await openModelPicker(page);
      expect(readCatalog).toHaveBeenCalledOnce();

      // Core and route replacements retire the pending picker read through the page owner.
      if (replacement === "core refresh") {
        page.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')!.click();
      } else {
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
        replacement === "core refresh" ? 3 : 2,
      );
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps replacement discovery active when retired discovery completes with %s",
    async (completion) => {
      const { context, readCatalog, snapshot } = createCatalogHarness();
      const retired = deferred<ModelCatalogResult>();
      const current = deferred<ModelCatalogResult>();
      const page = appendPage(context);
      await waitForFast(() => expect(page.data?.config).toEqual(savedModelConfig));
      await page.updateComplete;
      readCatalog.mockClear();
      readCatalog.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
      await openModelPicker(page);
      expect(readCatalog).toHaveBeenCalledOnce();

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
      expect(readCatalog).toHaveBeenCalledTimes(2);

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
      expect(readCatalog).toHaveBeenCalledTimes(2);
      current.resolve({
        models: [{ id: "current", name: "Current model", provider: "openai", available: true }],
      });
      await waitForFast(() => expect(page.data?.models?.[0]?.id).toBe("current"));
      await drainPageUpdates(page);
      expect(page.querySelector(".model-providers__catalog-progress")).toBeNull();
    },
  );

  it("keeps another page's independent catalog read when one page retires", async () => {
    const { context, readCatalog, snapshot } = createCatalogHarness();
    const pending = deferred<ModelCatalogResult>();
    const first = appendPage(context);
    const second = appendPage(context);
    await waitForFast(() => expect(first.data?.config).toEqual(savedModelConfig));
    await waitForFast(() => expect(second.data?.config).toEqual(savedModelConfig));
    await first.updateComplete;
    await second.updateComplete;
    readCatalog.mockClear();
    readCatalog.mockReturnValue(pending.promise);
    await openModelPicker(first);
    await openModelPicker(second);
    expect(readCatalog).toHaveBeenCalledTimes(2);
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
    expect(readCatalog).toHaveBeenCalledTimes(2);
  });
});
