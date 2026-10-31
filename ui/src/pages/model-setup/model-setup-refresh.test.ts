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
const nativeOption = '[role="option"][data-value="acp-opencode/fixture-model"]';
const catalogScope = { view: "all" as const, agentId: "main" };
function nativeControls(page: ParentNode) {
  const section = page.querySelector<HTMLElement>("[data-native-model-setup]")!;
  const button = (selector: string) => pageButton(section, selector)!;
  return {
    section,
    button,
    trigger: () => button(".picker-select__trigger"),
    alert: () => section.querySelector('[role="alert"]'),
    status: () => section.querySelector('p[role="status"]'),
  };
}

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
    const expectDraft = () => {
      expect(page.querySelector(manualInput)).toBe(input);
      expect(input).toMatchObject({ value: "synthetic-draft", disabled: false });
      expect(document.activeElement).toBe(input);
    };
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
    expectDraft();
    expect(scan.disabled).toBe(true);
    scan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(callsFor(request, "openclaw.setup.detect")).toHaveLength(1);
    pending.reject(new Error("Rescan failed. Try again."));
    await waitForFast(() => expect(scan.disabled).toBe(false));
    expectDraft();
    expect(page.querySelector('[role="alert"]')?.textContent).toContain("Rescan failed");
    const recovered = createDeferred<SystemAgentSetupDetectResult>();
    request.mockImplementation(() => recovered.promise);
    scan.click();
    await waitForFast(() => expect(scan.disabled).toBe(true));
    expect(page.querySelector('[role="alert"]')).toBeNull();
    recovered.resolve(inventory);
    await waitForFast(() => expect(scan.disabled).toBe(false));
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expectDraft();
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
      const { saving, completion, dispose } = createRoot((disposeRoot) => {
        const presentation = createModelSetupSaving(() => null);
        return {
          saving: presentation,
          completion: owned && presentation.present(Promise.resolve(), () => false),
          dispose: disposeRoot,
        };
      });
      const pending = completion || saving.present(Promise.resolve(), () => false);
      saving.retire();
      dispose();
      await pending;
    },
  );

  it.each([false, true])(
    "retries a failed native catalog with cached choices: %s",
    async (warm) => {
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
      if (warm) {
        publishModelCatalogResult(
          beginModelCatalogRead(client, catalogScope),
          catalogScope,
          cached,
        );
      }
      const { section, button, trigger: getTrigger, alert, status } = nativeControls(page);
      const trigger = getTrigger();
      const expectSelection = () => {
        expect(getTrigger()).toBe(trigger);
        expect(button("button.primary").disabled).toBe(false);
      };
      try {
        trigger.click();
        if (warm) {
          await waitForElement(section, nativeOption);
          section.querySelector<HTMLElement>(nativeOption)!.click();
          await page.updateComplete;
          expect(trigger.textContent).toContain("Cached fixture model");
          expectSelection();
          expect(status()).not.toBeNull();
          await selectManualProvider(page, "fixture-key");
          expect(callsFor(request, "models.list")).toHaveLength(1);
        }
        pending.reject(new Error("Catalog refresh failed. Try again."));
        await waitForFast(() => expect(alert()?.textContent).toContain("Catalog refresh failed"));
        if (warm) {
          expectSelection();
        }
        button('[role="alert"] button').click();
        await waitForFast(() => {
          expect(callsFor(request, "models.list")).toHaveLength(2);
          expect(alert()).toBeNull();
          if (!warm) {
            expect(status()?.textContent).toContain("Checking installed agents");
          }
        });
        retry.resolve({ models: warm ? [{ ...model, name: "Refreshed fixture model" }] : [] });
        if (warm) {
          await waitForFast(() => expect(trigger.textContent).toContain("Refreshed fixture model"));
          expectSelection();
          expect(status()).toBeNull();
        } else {
          await waitForFast(() =>
            expect(status()?.textContent).toContain(
              "No models are available from installed agents",
            ),
          );
        }
        expect(alert()).toBeNull();
      } finally {
        pending.resolve(cached);
        retry.resolve(cached);
      }
    },
  );

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
    const { section, button, trigger, alert, status } = nativeControls(page);
    const saveError = "The model choice could not be saved.";
    try {
      trigger().click();
      await waitForElement(section, nativeOption);
      section.querySelector<HTMLElement>(nativeOption)!.click();
      await page.updateComplete;
      catalog = {
        models: [model, { ...model, id: "new-model", name: "New published model" }],
        pendingProviders: ["acp-qwen"],
      };
      const publish = (value: ModelCatalogResult) =>
        publishModelCatalogResult(beginModelCatalogRead(client, catalogScope), catalogScope, value);
      publish(catalog);
      trigger().click();
      await waitForElement(section, '[role="option"][data-value="acp-opencode/new-model"]');
      expect(discoveries).toBe(1);
      expect(section.querySelector('[role="option"][aria-selected="true"]')).toBe(
        section.querySelector(nativeOption),
      );
      trigger().click();
      await updatePickers(page);
      catalog = { ...catalog, refreshFailed: true };
      publish(catalog);
      trigger().click();
      await waitForFast(() => expect(button('[role="alert"] button').disabled).toBe(false));
      expect(discoveries).toBe(1);
      button('[role="alert"] button').click();
      await page.updateComplete;
      expect(discoveries).toBe(2);
      expect(status()).not.toBeNull();
      expect(button("button.primary").disabled).toBe(false);
      await selectManualProvider(page, "fixture-key");
      expect(page.querySelector<HTMLInputElement>(manualInput)?.disabled).toBe(false);
      retry.resolve({ models: catalog.models });
      await waitForFast(() => expect(status()).toBeNull());
      expect(alert()).toBeNull();
      expect(trigger().textContent).toContain("Fixture model");
      button("button.primary").click();
      await waitForFast(() => expect(alert()?.textContent).toContain(saveError));
      publish({ models: [model] });
      trigger().click();
      await page.updateComplete;
      await updatePickers(page);
      expect(alert()?.textContent).toContain(saveError);
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
