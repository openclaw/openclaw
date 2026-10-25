/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelCatalogResult, SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { beginModelCatalogRead, publishModelCatalogResult } from "../../lib/model-catalog-cache.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createFirstRunContext,
  detection,
  mountDetection,
  selectManualProvider,
  setInput,
  callsFor,
  waitForElement,
  pageButton,
  nativeModel,
} from "./model-setup-first-run.test-support.ts";
import { createModelSetupSaving } from "./model-setup-saving.ts";
import { createNativeModelSetup } from "./native-model-setup.tsx";

const inventory: SystemAgentSetupDetectResult = {
  ...detection,
  manualProviders: [{ id: "fixture-key", label: "Fixture provider" }],
};
const manualInput = ".model-setup__manual input";
const scanButton = (page: ParentNode) =>
  [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro button")].find(
    (button) => button.textContent?.trim() === "Check again",
  )!;

describe("Model setup refresh continuity", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps editable drafts and focus through a failed rescan and its retry", async () => {
    const warnings = vi.spyOn(console, "warn");
    const { context, client, request } = createFirstRunContext();
    const { page } = await mountDetection(context, client, inventory, false);
    await selectManualProvider(page, "fixture-key");
    const input = page.querySelector<HTMLInputElement>(manualInput)!;
    setInput(page, manualInput, "synthetic-draft");
    input.focus();
    const pending = createDeferred<SystemAgentSetupDetectResult>();
    request.mockImplementation(async (method) => {
      if (method === "openclaw.setup.detect") {
        return pending.promise;
      }
      throw new Error("Unexpected request: " + method);
    });
    const scan = scanButton(page);
    scan.click();
    await page.updateComplete;
    expect(page.querySelector(".model-setup__loading")).toBeNull();
    expect(page.querySelector(manualInput)).toBe(input);
    expect(input).toMatchObject({ value: "synthetic-draft", disabled: false });
    expect(document.activeElement).toBe(input);
    expect(scan.disabled).toBe(true);
    scan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(callsFor(request, "openclaw.setup.detect")).toHaveLength(1);
    pending.reject(new Error("Rescan failed. Try again."));
    await waitForFast(() => expect(scan.disabled).toBe(false));
    expect(page.querySelector(manualInput)).toBe(input);
    expect(input.value).toBe("synthetic-draft");
    expect(document.activeElement).toBe(input);
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Rescan failed");
    const recovered = createDeferred<SystemAgentSetupDetectResult>();
    request.mockImplementation(() => recovered.promise);
    scan.click();
    await waitForFast(() => expect(scan.disabled).toBe(true));
    expect(page.querySelector('[role="alert"]')).toBeNull();
    recovered.resolve(inventory);
    await waitForFast(() => expect(scan.disabled).toBe(false));
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.querySelector(manualInput)).toBe(input);
    expect(input.value).toBe("synthetic-draft");
    expect(document.activeElement).toBe(input);
    expect(warnings.mock.calls.flat().join("\n")).not.toContain("[STRICT_READ_UNTRACKED]");
  });

  it("admits native catalog refresh before its asynchronous read is observed", () => {
    const { context, client, request } = createFirstRunContext();
    const unsubscribe = vi.fn();
    vi.spyOn(context.gateway, "subscribeEvents").mockReturnValue(unsubscribe);
    request.mockResolvedValue({ models: [] });
    const { owner, dispose } = createRoot((disposeRoot) => ({
      owner: createNativeModelSetup({
        getContext: () => context,
        getConnection: () => null,
        canUseSetup: (candidate) => candidate === client,
        blocked: () => false,
        onSelected: () => {},
        onChange: () => {},
      }),
      dispose: disposeRoot,
    }));
    try {
      owner.open();
      expect(callsFor(request, "models.list")).toHaveLength(1);
      owner.open();
      expect(callsFor(request, "models.list")).toHaveLength(1);
    } finally {
      dispose();
    }
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "settles a retired save before first settle (owned: %s)",
    async (owned) => {
      const {
        saving,
        completion: ownedCompletion,
        dispose,
      } = createRoot((disposeRoot) => {
        const presentation = createModelSetupSaving(() => null);
        return {
          saving: presentation,
          completion: owned ? presentation.present(Promise.resolve(), () => false) : undefined,
          dispose: disposeRoot,
        };
      });
      const completion = ownedCompletion ?? saving.present(Promise.resolve(), () => false);
      saving.retire();
      dispose();
      await completion;
    },
  );

  it("admits one native refresh on open and keeps cached choices through failure and retry", async () => {
    const { context, client, request } = createFirstRunContext();
    const model = nativeModel("Cached fixture model");
    const cached: ModelCatalogResult = { models: [model] };
    const pending = createDeferred<ModelCatalogResult>();
    const retry = createDeferred<ModelCatalogResult>();
    let reads = 0;
    request.mockImplementation(async (method) => {
      if (method === "models.list") {
        return ++reads === 1 ? pending.promise : retry.promise;
      }
      throw new Error("Unexpected request: " + method);
    });
    const { page } = await mountDetection(context, client, inventory, false);
    const scope = { view: "all" as const, agentId: "main" };
    publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, cached);
    const section = page.querySelector<HTMLElement>("[data-native-model-setup]")!;
    const trigger = pageButton(section, ".picker-select__trigger")!;
    const option = '[role="option"][data-value="acp-opencode/fixture-model"]';
    try {
      trigger.click();
      await waitForElement(section, option);
      section.querySelector<HTMLElement>(option)!.click();
      await page.updateComplete;
      expect(trigger.textContent).toContain("Cached fixture model");
      expect(pageButton(section, "button.primary")?.disabled).toBe(false);
      expect(section.querySelector('p[role="status"]')).not.toBeNull();
      await selectManualProvider(page, "fixture-key");
      expect(callsFor(request, "models.list")).toHaveLength(1);
      pending.reject(new Error("Catalog refresh failed. Try again."));
      await waitForFast(() =>
        expect(section.querySelector('[role="alert"]')?.textContent).toContain(
          "Catalog refresh failed",
        ),
      );
      expect(pageButton(section, ".picker-select__trigger")).toBe(trigger);
      expect(pageButton(section, "button.primary")?.disabled).toBe(false);
      pageButton(section, '[role="alert"] button')!.click();
      await waitForFast(() => expect(callsFor(request, "models.list")).toHaveLength(2));
      retry.resolve({ models: [{ ...model, name: "Refreshed fixture model" }] });
      await waitForFast(() => expect(trigger.textContent).toContain("Refreshed fixture model"));
      expect(pageButton(section, ".picker-select__trigger")).toBe(trigger);
      expect(pageButton(section, "button.primary")?.disabled).toBe(false);
      expect(section.querySelector('p[role="status"]')).toBeNull();
      expect(section.querySelector('[role="alert"]')).toBeNull();
    } finally {
      pending.resolve(cached);
      retry.resolve(cached);
    }
  });

  it("shows native catalog progress during a cold retry", async () => {
    const { context, client, request } = createFirstRunContext();
    const retry = createDeferred<ModelCatalogResult>();
    let reads = 0;
    request.mockImplementation(async (method) => {
      if (method === "models.list") {
        if (++reads === 1) {
          throw new Error("Cold catalog read failed.");
        }
        return retry.promise;
      }
      throw new Error("Unexpected request: " + method);
    });
    const { page } = await mountDetection(context, client, inventory, false);
    const section = page.querySelector<HTMLElement>("[data-native-model-setup]")!;
    try {
      pageButton(section, ".picker-select__trigger")!.click();
      await waitForFast(() =>
        expect(section.querySelector('[role="alert"]')?.textContent).toContain(
          "Cold catalog read failed",
        ),
      );
      pageButton(section, '[role="alert"] button')!.click();
      await waitForFast(() => {
        expect(callsFor(request, "models.list")).toHaveLength(2);
        expect(section.querySelector('p[role="status"]')?.textContent).toContain(
          "Checking installed agents",
        );
        expect(section.querySelector('[role="alert"]')).toBeNull();
      });
      retry.resolve({ models: [] });
      await waitForFast(() =>
        expect(section.querySelector('p[role="status"]')?.textContent).toContain(
          "No models are available from installed agents",
        ),
      );
    } finally {
      retry.resolve({ models: [] });
    }
  });

  it("reopens the published native inventory without restarting discovery and retries explicitly", async () => {
    const { context, client, request } = createFirstRunContext();
    const model = nativeModel();
    let catalog: ModelCatalogResult = { models: [model], pendingProviders: ["acp-qwen"] };
    const retry = createDeferred<ModelCatalogResult>();
    let discoveries = 0;
    request.mockImplementation(async (method, params) => {
      if (method === "models.list") {
        if (
          params &&
          typeof params === "object" &&
          "refresh" in params &&
          params.refresh === true &&
          ++discoveries > 1
        ) {
          return retry.promise;
        }
        return catalog;
      }
      if (method === "agents.update") {
        throw new Error("The model choice could not be saved.");
      }
      throw new Error("Unexpected request: " + method);
    });
    const { page } = await mountDetection(context, client, inventory, false);
    const section = page.querySelector<HTMLElement>("[data-native-model-setup]")!;
    const button = (selector: string) => pageButton(section, selector)!;
    const trigger = () => button(".picker-select__trigger");
    const alert = '[role="alert"]';
    const pendingStatus = 'p[role="status"]';
    const saveError = "The model choice could not be saved.";
    const option = '[role="option"][data-value="acp-opencode/fixture-model"]';
    try {
      trigger().click();
      await waitForElement(section, option);
      section.querySelector<HTMLElement>(option)!.click();
      await page.updateComplete;
      catalog = {
        models: [model, { ...model, id: "new-model", name: "New published model" }],
        pendingProviders: ["acp-qwen"],
      };
      const scope = { view: "all" as const, agentId: "main" };
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, catalog);
      trigger().click();
      await waitForElement(section, '[role="option"][data-value="acp-opencode/new-model"]');
      expect(discoveries).toBe(1);
      expect(section.querySelector('[role="option"][aria-selected="true"]')).toBe(
        section.querySelector(option),
      );
      trigger().click();
      await updatePickers(page);
      catalog = { ...catalog, refreshFailed: true };
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, catalog);
      trigger().click();
      await waitForFast(() => expect(button(`${alert} button`).disabled).toBe(false));
      expect(discoveries).toBe(1);
      button(`${alert} button`).click();
      await page.updateComplete;
      expect(discoveries).toBe(2);
      expect(section.querySelector(pendingStatus)).not.toBeNull();
      expect(button("button.primary").disabled).toBe(false);
      await selectManualProvider(page, "fixture-key");
      expect(page.querySelector<HTMLInputElement>(manualInput)?.disabled).toBe(false);
      retry.resolve({ models: catalog.models });
      await waitForFast(() => expect(section.querySelector(pendingStatus)).toBeNull());
      expect(section.querySelector(alert)).toBeNull();
      expect(trigger().textContent).toContain("Fixture model");
      button("button.primary").click();
      await waitForFast(() =>
        expect(section.querySelector(alert)?.textContent).toContain(saveError),
      );
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, { models: [model] });
      trigger().click();
      await page.updateComplete;
      await updatePickers(page);
      expect(section.querySelector(alert)?.textContent).toContain(saveError);
    } finally {
      retry.resolve({ models: catalog.models });
    }
  });

  it.each(["scope", "revision"])(
    "clears drafts and ignores late rescans after owner %s changes",
    async (change) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const nativeInput = ".model-setup__native-discovery input";
      const fresh = {
        ...inventory,
        nativeSessionCatalogPreferenceRequired: true,
        nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
      };
      const { page } = await mountDetection(context, client, fresh, change === "revision");
      page.querySelector<HTMLInputElement>(nativeInput)!.click();
      await selectManualProvider(page, "fixture-key");
      setInput(page, manualInput, "old-owner-draft");
      const pending = createDeferred<SystemAgentSetupDetectResult>();
      request
        .mockImplementationOnce(async () => pending.promise)
        .mockResolvedValue({ ...fresh, workspace: "/new-owner" });
      scanButton(page).click();
      await page.updateComplete;
      if (change === "revision") {
        Object.assign(context.gateway, {
          connectionRevision: context.gateway.connectionRevision + 1,
        });
        publishGatewaySnapshot({ ...snapshot });
      } else {
        publishGatewaySnapshot({
          ...snapshot,
          hello: {
            ...snapshot.hello,
            auth: { ...snapshot.hello.auth, recoveryScope: "replacement-owner" },
          },
        });
      }
      await waitForFast(() =>
        expect(page.querySelector<HTMLInputElement>(manualInput)?.value).toBe(""),
      );
      pending.resolve({ ...inventory, configuredModel: "fixture/stale-model" });
      await page.updateComplete;
      await Promise.resolve();
      expect(page.textContent).not.toContain("stale-model");
      expect(page.querySelector<HTMLInputElement>(manualInput)?.value).toBe("");
      expect(page.querySelector(nativeInput)).toMatchObject({ checked: false });
      expect(page.querySelector("[data-selected]")).toBeNull();
    },
  );
});
