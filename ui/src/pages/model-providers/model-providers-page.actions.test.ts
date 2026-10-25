/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  drainPageUpdates,
  modelPicker,
  requestCount,
  saveKey,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage mutation presentation", () => {
  it("keeps a held API-key save visible, preserves its failed draft, and permits retry", async () => {
    const { context, request } = createHarness("main");
    const pending = deferred<unknown>();
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method === "models.authSetApiKey" ? pending.promise : original(method),
    );
    const page = appendPage(context);
    await waitForProviders(page);
    await saveKey(page, "synthetic-api-key");

    await waitForSolid(() => {
      expect(requestCount(request, "models.authSetApiKey")).toBe(1);
      expect(
        page.querySelector<HTMLInputElement>(".model-providers__inline-form input")?.disabled,
      ).toBe(true);
      expect(page.querySelector(".model-providers__inline-form button")?.textContent).toContain(
        "Saving",
      );
    });
    page.querySelector<HTMLButtonElement>(".model-providers__inline-form button")!.click();
    expect(requestCount(request, "models.authSetApiKey")).toBe(1);

    pending.reject(new Error("Synthetic credential rejection"));
    await waitForSolid(() => {
      expect(page.renderRoot.textContent).toContain("Synthetic credential rejection");
      const input = page.querySelector<HTMLInputElement>(".model-providers__inline-form input");
      expect(input?.value).toBe("synthetic-api-key");
      expect(input?.disabled).toBe(false);
    });

    request.mockImplementation(async (method) =>
      method === "models.authSetApiKey" ? {} : original(method),
    );
    page.querySelector<HTMLButtonElement>(".model-providers__inline-form button")!.click();
    await waitForSolid(() =>
      expect(page.querySelector(".model-providers__inline-form")).toBeNull(),
    );
    expect(requestCount(request, "models.authSetApiKey")).toBe(2);
  });

  it("retains disabled defaults during a write and restores the saved selection on failure", async () => {
    const { context, runtimeConfig, request } = createHarness("main");
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (method) =>
      method === "models.list"
        ? {
            models: [
              { id: "synthetic-model", provider: "openai", name: "Synthetic", available: true },
            ],
          }
        : original(method),
    );
    const page = appendPage(context);
    await waitForProviders(page);
    const previous = page.view.props.defaultModels.primary;
    const pending = deferred<boolean>();
    runtimeConfig.patch.mockImplementationOnce(() => pending.promise);
    const behaviorDefaults = [
      ...page.querySelectorAll<HTMLInputElement>(
        '.settings-segmented__input[type="radio"][value=""]',
      ),
    ];
    expect(behaviorDefaults).toHaveLength(2);

    page.view.props.onPrimaryChange("openai/synthetic-model");
    await waitForSolid(() => {
      expect(runtimeConfig.patch).toHaveBeenCalledTimes(1);
      expect(
        modelPicker(page, "primary").querySelector<HTMLButtonElement>(".picker-select__trigger")
          ?.disabled,
      ).toBe(true);
      expect(behaviorDefaults.every((input) => input.disabled)).toBe(true);
    });
    expect(page.view.props.defaultModels.primary).toBe("openai/synthetic-model");

    pending.reject(new Error("Synthetic defaults rejection"));
    await waitForSolid(() => {
      expect(page.view.props.defaultModels.primary).toBe(previous);
      expect(page.renderRoot.textContent).toContain("Synthetic defaults rejection");
      expect(
        modelPicker(page, "primary").querySelector<HTMLButtonElement>(".picker-select__trigger")
          ?.disabled,
      ).toBe(false);
      expect(behaviorDefaults.every((input) => !input.disabled)).toBe(true);
    });
  });

  it.each(["thinking", "fastMode"] as const)(
    "keeps only the initiating %s control focusable through rejection and retry",
    async (field) => {
      const { context, runtimeConfig } = createHarness("main");
      const page = appendPage(context);
      await waitForProviders(page);
      const groups = page.querySelectorAll<HTMLElement>(
        '.model-providers__defaults [role="radiogroup"]',
      );
      expect(groups).toHaveLength(2);
      const own =
        groups[field === "thinking" ? 0 : 1]!.querySelector<HTMLInputElement>('input[value=""]')!;
      const other =
        groups[field === "thinking" ? 1 : 0]!.querySelector<HTMLInputElement>('input[value=""]')!;
      const pending = deferred<boolean>();
      runtimeConfig.patch.mockImplementationOnce(() => pending.promise);
      own.focus();
      own.click();
      flush();
      expect(own.disabled).toBe(false);
      expect(other.disabled).toBe(true);
      expect(document.activeElement).toBe(own);
      await waitForSolid(() => {
        expect(runtimeConfig.patch).toHaveBeenCalledOnce();
        expect(own.getAttribute("aria-disabled")).toBe("true");
      });
      own.click();
      other.click();
      expect(runtimeConfig.patch).toHaveBeenCalledOnce();

      pending.reject(new Error("Synthetic behavior rejection"));
      await waitForSolid(() => {
        expect(page.renderRoot.textContent).toContain("Synthetic behavior rejection");
        expect(own.getAttribute("aria-disabled")).toBeNull();
        expect(own.disabled).toBe(false);
        expect(other.disabled).toBe(false);
      });
      own.click();
      await waitForSolid(() => {
        expect(runtimeConfig.patch).toHaveBeenCalledTimes(2);
        expect(own.getAttribute("aria-disabled")).toBeNull();
        expect(other.disabled).toBe(false);
        expect(page.renderRoot.textContent).not.toContain("Synthetic behavior rejection");
      });
    },
  );

  it.each(["agent", "reconnect", "navigation"] as const)(
    "retires a held credential presentation on %s before the old write settles",
    async (retirement) => {
      const { context, request, settingsAgentSelection, notifySelection, publishPhase } =
        createHarness("main");
      const pending = deferred<unknown>();
      const original = request.getMockImplementation()!;
      request.mockImplementation(async (method) => {
        if (method === "models.authSetApiKey") {
          return pending.promise;
        }
        if (method === "models.authStatus") {
          return createAuthStatus();
        }
        return original(method);
      });
      const page = appendPage(context);
      await waitForProviders(page);
      await saveKey(page, "synthetic-retired-key");
      await waitForSolid(() => expect(requestCount(request, "models.authSetApiKey")).toBe(1));

      if (retirement === "agent") {
        settingsAgentSelection.state.selectedId = "writer";
        notifySelection();
      } else if (retirement === "reconnect") {
        publishPhase("reconnecting");
        publishPhase("connected");
      } else {
        await context.router.navigate("chat", context);
        page.view.props.onKeyDraftChange("synthetic-draft-after-navigation");
      }
      await waitForSolid(() => {
        if (retirement === "agent") {
          expect(page.view.props.credentialAgentLabel).toBe("Writer");
          expect(page.querySelector(".model-providers__inline-form")).toBeNull();
        } else if (retirement === "reconnect") {
          expect(
            page.querySelector<HTMLInputElement>(".model-providers__inline-form input")?.disabled,
          ).toBe(false);
        } else {
          expect(
            page.querySelector<HTMLInputElement>(".model-providers__inline-form input")?.value,
          ).toBe("synthetic-draft-after-navigation");
        }
      });

      if (retirement === "navigation") {
        pending.resolve({});
      } else {
        pending.reject(new Error("Retired credential failure"));
      }
      await drainPageUpdates(page);
      expect(page.renderRoot.textContent).not.toContain("Retired credential failure");
      expect(page.view.props.credentialAgentLabel).toBe(retirement === "agent" ? "Writer" : "Main");
    },
  );
});
