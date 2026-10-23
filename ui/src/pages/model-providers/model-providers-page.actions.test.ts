/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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

    page.view.props.onPrimaryChange("openai/synthetic-model");
    await waitForSolid(() => {
      expect(runtimeConfig.patch).toHaveBeenCalledTimes(1);
      expect(
        modelPicker(page, "primary").querySelector<HTMLButtonElement>(".picker-select__trigger")
          ?.disabled,
      ).toBe(true);
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
    });
  });

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
