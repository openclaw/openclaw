/* @vitest-environment jsdom */
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
  mountPage,
  selectManualProvider,
} from "./model-setup-first-run.test-support.ts";

const inventory: SystemAgentSetupDetectResult = {
  ...detection,
  manualProviders: [{ id: "fixture-key", label: "Fixture provider" }],
};

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

  it.each(["success", "failure"] as const)(
    "keeps editable drafts and focus through a rescan %s",
    async (outcome) => {
      const { context, client, request } = createFirstRunContext();
      const { page } = await mountPage(context, {
        client,
        firstRun: false,
        state: { phase: "ready", result: inventory },
      });
      await selectManualProvider(page, "fixture-key");
      const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
      input.value = "synthetic-draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      const pending = createDeferred<SystemAgentSetupDetectResult>();
      request.mockImplementation(async (method) => {
        if (method === "openclaw.setup.detect") {
          return pending.promise;
        }
        throw new Error("Unexpected request: " + method);
      });
      const scan = [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro button")].find(
        (button) => button.textContent?.trim() === "Check again",
      )!;
      scan.click();
      await page.updateComplete;
      expect(page.querySelector(".model-setup__loading")).toBeNull();
      expect(page.querySelector(".model-setup__manual input")).toBe(input);
      expect(input.value).toBe("synthetic-draft");
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
      expect(scan.disabled).toBe(true);
      scan.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(
        request.mock.calls.filter(([method]) => method === "openclaw.setup.detect"),
      ).toHaveLength(1);
      if (outcome === "success") {
        pending.resolve(inventory);
      } else {
        pending.reject(new Error("Rescan failed. Try again."));
      }
      await waitForFast(() => expect(scan.disabled).toBe(false));
      expect(page.querySelector(".model-setup__manual input")).toBe(input);
      expect(input.value).toBe("synthetic-draft");
      expect(document.activeElement).toBe(input);
      if (outcome === "failure") {
        expect(page.querySelector('[role="alert"]')?.textContent).toContain("Rescan failed");
      }
    },
  );

  it("reopens the published native inventory without restarting discovery and retries explicitly", async () => {
    const { context, client, request } = createFirstRunContext();
    const model = {
      provider: "acp-opencode",
      id: "fixture-model",
      name: "Fixture model",
      available: true,
      agentRuntime: { id: "acp-opencode", source: "implicit" as const },
    };
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
    const { page } = await mountPage(context, {
      client,
      firstRun: false,
      state: { phase: "ready", result: inventory },
    });
    const section = page.querySelector<HTMLElement>("[data-native-model-setup]")!;
    const trigger = () => section.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
    const option = '[role="option"][data-value="acp-opencode/fixture-model"]';
    try {
      trigger().click();
      await waitForFast(() => expect(section.querySelector(option)).not.toBeNull());
      section.querySelector<HTMLElement>(option)!.click();
      await page.updateComplete;
      catalog = {
        models: [model, { ...model, id: "new-model", name: "New published model" }],
        pendingProviders: ["acp-qwen"],
      };
      const scope = { view: "all" as const, agentId: "main" };
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, catalog);
      trigger().click();
      await waitForFast(() =>
        expect(
          section.querySelector('[role="option"][data-value="acp-opencode/new-model"]'),
        ).not.toBeNull(),
      );
      expect(discoveries).toBe(1);
      expect(section.querySelector('[role="option"][aria-selected="true"]')).toBe(
        section.querySelector(option),
      );
      trigger().click();
      await updatePickers(page);
      catalog = { ...catalog, refreshFailed: true };
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, catalog);
      trigger().click();
      await waitForFast(() =>
        expect(section.querySelector<HTMLButtonElement>('[role="alert"] button')?.disabled).toBe(
          false,
        ),
      );
      expect(discoveries).toBe(1);
      const retryButton = section.querySelector<HTMLButtonElement>('[role="alert"] button')!;
      retryButton.click();
      await page.updateComplete;
      expect(discoveries).toBe(2);
      expect(section.querySelector('p[role="status"]')).not.toBeNull();
      expect(section.querySelector<HTMLButtonElement>("button.primary")?.disabled).toBe(false);
      await selectManualProvider(page, "fixture-key");
      expect(page.querySelector<HTMLInputElement>(".model-setup__manual input")?.disabled).toBe(
        false,
      );
      retry.resolve({ models: catalog.models });
      await waitForFast(() => expect(section.querySelector('p[role="status"]')).toBeNull());
      expect(section.querySelector('[role="alert"]')).toBeNull();
      expect(trigger().textContent).toContain("Fixture model");
      section.querySelector<HTMLButtonElement>("button.primary")!.click();
      await waitForFast(() =>
        expect(section.querySelector('[role="alert"]')?.textContent).toContain(
          "The model choice could not be saved.",
        ),
      );
      publishModelCatalogResult(beginModelCatalogRead(client, scope), scope, { models: [model] });
      trigger().click();
      await page.updateComplete;
      await updatePickers(page);
      expect(section.querySelector('[role="alert"]')?.textContent).toContain(
        "The model choice could not be saved.",
      );
    } finally {
      retry.resolve({ models: catalog.models });
    }
  });

  it("clears the old owner's draft and ignores its late rescan", async () => {
    const { context, client, request, snapshot, publishGatewaySnapshot } = createFirstRunContext();
    const { page } = await mountPage(context, {
      client,
      firstRun: false,
      state: { phase: "ready", result: inventory },
    });
    await selectManualProvider(page, "fixture-key");
    const input = page.querySelector<HTMLInputElement>(".model-setup__manual input")!;
    input.value = "old-owner-draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const pending = createDeferred<SystemAgentSetupDetectResult>();
    request
      .mockImplementationOnce(async () => pending.promise)
      .mockResolvedValue({ ...inventory, workspace: "/new-owner" });
    [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro button")]
      .find((button) => button.textContent?.trim() === "Check again")!
      .click();
    await page.updateComplete;
    publishGatewaySnapshot({
      ...snapshot,
      hello: {
        ...snapshot.hello,
        auth: { ...snapshot.hello.auth, recoveryScope: "replacement-owner" },
      },
    });
    await waitForFast(() =>
      expect(page.querySelector<HTMLInputElement>(".model-setup__manual input")?.value).toBe(""),
    );
    pending.resolve({ ...inventory, configuredModel: "fixture/stale-model" });
    await page.updateComplete;
    await Promise.resolve();
    expect(page.textContent).not.toContain("stale-model");
    expect(page.querySelector<HTMLInputElement>(".model-setup__manual input")?.value).toBe("");
  });
});
