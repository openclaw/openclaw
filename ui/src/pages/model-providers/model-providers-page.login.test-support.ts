import { expect } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult, WizardNextResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  clickLoginChoice,
  createHarness,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
} from "./model-providers-page.test-support.tsx";

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
  await waitForSolid(() => expect(page.state.data?.updatedAt).toEqual(expect.any(Number)));
  await waitForSolid(() =>
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false),
  );
  page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
  await page.updateComplete;
}

export async function selectProvider(page: ModelProvidersPageTestElement, provider: string) {
  page.querySelector<HTMLButtonElement>(`[data-models-login-provider="${provider}"]`)!.click();
  await page.updateComplete;
}

export async function chooseLogin(page: ModelProvidersPageTestElement, choice = "example-secret") {
  await openPicker(page);
  await selectProvider(page, "example");
  clickLoginChoice(page, choice);
}

export async function openLogin(page: ModelProvidersPageTestElement, choice = "example-secret") {
  await openPicker(page);
  await selectProvider(page, "example");
  await startSelectedLogin(page, choice);
}
