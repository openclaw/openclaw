import { expect } from "vitest";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ModelAuthStatusResult, WizardNextResult } from "../api/types.ts";
import {
  createHarness,
  type ModelProvidersPageTestElement,
} from "../pages/model-providers/model-providers-page.test-support.ts";
import { waitForFast } from "./wait-for.ts";

export function loginHarness(
  options: {
    capabilities?: ModelAuthStatusResult["providerCapabilities"];
    providers?: ModelAuthStatusResult["providers"];
    saved?: boolean;
  } = {},
) {
  const harness = createHarness("writer");
  const { context, request } = harness;
  const originalRequest = request.getMockImplementation()!;
  let saved = options.saved ?? false;
  let stepShown = false;
  const answer = deferred<WizardNextResult>();
  const cancel = deferred<{ status: "running" | "cancelled" }>();
  const status = deferred<{ status: "cancelled" }>();
  const authStatus = (): ModelAuthStatusResult => ({
    ts: 1,
    providers:
      options.providers ??
      (saved
        ? [
            {
              provider: "example",
              displayName: "Example provider",
              status: "ok",
              profiles: [{ profileId: "example:new", type: "api_key", status: "ok" }],
            },
          ]
        : []),
    providerCapabilities: options.capabilities ?? [
      {
        provider: "example",
        apiKeySupported: true,
        quickApiKeySetup: true,
        loginOptions: [
          {
            id: "example-browser",
            brandId: "example",
            label: "Example browser sign-in",
            kind: "oauth",
            featured: true,
          },
          {
            id: "example-secret",
            brandId: "example",
            label: "Example API key",
            groupLabel: "Example provider",
            hint: "Use your Example account key",
            kind: "secret",
            featured: false,
          },
        ],
      },
    ],
  });
  request.mockImplementation(async (method: string) => {
    switch (method) {
      case "models.authStatus":
        return authStatus();
      case "models.authLogin":
        return { done: false, status: "running" };
      case "wizard.next":
        if (!stepShown) {
          stepShown = true;
          return {
            done: false,
            status: "running",
            step: { id: "credential", type: "text", sensitive: true, message: "Enter your key" },
          };
        }
        return answer.promise.then((result) => {
          saved = result.done && result.status === "done";
          return result;
        });
      case "wizard.cancel":
        return cancel.promise;
      case "wizard.status":
        return status.promise;
      default:
        return originalRequest(method);
    }
  });
  context.runtimeConfig.runExternalMutation = async (task, mutationOptions) => {
    if (mutationOptions?.canDispatch?.() === false) {
      return { ok: false, reason: "rejected", error: "Sign-in owner changed" };
    }
    const value = await task(context.gateway.snapshot.client!);
    return { ok: true, value, refresh: { ok: true } };
  };
  return { ...harness, answer, cancel, status };
}

export async function openPicker(page: ModelProvidersPageTestElement) {
  await waitForFast(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false),
  );
  page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
  await page.updateComplete;
}

export async function selectProvider(page: ModelProvidersPageTestElement, provider: string) {
  page.querySelector<HTMLButtonElement>(`[data-models-login-provider="${provider}"]`)!.click();
  await page.updateComplete;
}

export async function searchProviders(page: ModelProvidersPageTestElement, query: string) {
  const input = page.querySelector<HTMLInputElement>("[data-models-login-search]")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
}

export function providerChoices(page: Element) {
  return [...page.querySelectorAll<HTMLElement>("[data-models-login-provider]")].map(
    (button) => button.dataset.modelsLoginProvider,
  );
}
