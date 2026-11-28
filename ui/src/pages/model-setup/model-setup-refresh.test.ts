/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createFirstRunContext,
  detection,
  mountDetection,
  selectManualProvider,
  setInput,
  callsFor,
} from "./model-setup-first-run.test-support.ts";
import { createModelSetupSaving } from "./model-setup-saving.ts";

const inventory: SystemAgentSetupDetectResult = {
  ...detection,
  manualProviders: [{ id: "fixture-key", label: "Fixture provider" }],
};
const manualInput = ".model-setup__manual input";
const scanButton = (page: ParentNode) =>
  [...page.querySelectorAll<HTMLButtonElement>(".model-setup__intro button")].find(
    (button) => (button.getAttribute("aria-label") ?? button.textContent?.trim()) === "Check again",
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

  it.each(["scope", "revision"])(
    "clears drafts and ignores late rescans after owner %s changes",
    async (change) => {
      const { context, client, request, snapshot, publishGatewaySnapshot } =
        createFirstRunContext();
      const { page } = await mountDetection(context, client, inventory, change === "revision");
      page.discoveryOpen = true;
      await page.updateComplete;
      await selectManualProvider(page, "fixture-key");
      setInput(page, manualInput, "old-owner-draft");
      const pending = createDeferred<SystemAgentSetupDetectResult>();
      request
        .mockImplementationOnce(async () => pending.promise)
        .mockResolvedValue({ ...inventory, workspace: "/new-owner" });
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
      expect(page.querySelector("[data-selected]")).toBeNull();
    },
  );
});
