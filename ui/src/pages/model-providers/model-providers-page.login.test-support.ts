import { expect } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult, WizardNextResult } from "../../api/types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  clickLoginChoice,
  createAuthStatus,
  createHarness,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

export function museCodeCapability(): NonNullable<
  ModelAuthStatusResult["providerCapabilities"]
>[number] {
  return {
    provider: "meta",
    apiKeySupported: true,
    quickApiKeySetup: true,
    loginOptions: [
      {
        id: "meta/muse-code",
        brandId: "meta",
        label: "Muse Code",
        kind: "device-code",
        featured: true,
        requiresSetup: true,
      },
    ],
  };
}

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
  const savedProviders = () =>
    createAuthStatus([
      {
        provider: "example",
        displayName: "Example provider",
        profiles: [{ profileId: "example:new", type: "api_key", status: "ok" }],
      },
    ]).providers;
  const responses: Record<string, () => unknown> = {
    "models.authStatus": (): ModelAuthStatusResult => ({
      ts: 1,
      providers: options.providers ?? (saved ? savedProviders() : []),
      providerCapabilities: options.capabilities ?? [
        {
          provider: "example",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: (["oauth", "secret"] as const).map((kind) => ({
            id: `example-${kind === "oauth" ? "browser" : kind}`,
            brandId: "example",
            label: `Example ${kind === "oauth" ? "browser sign-in" : "API key"}`,
            kind,
            featured: kind === "oauth",
            groupLabel: kind === "secret" ? "Example provider" : undefined,
            hint: kind === "secret" ? "Use your Example account key" : undefined,
          })),
        },
      ],
    }),
    "models.authLogin": () => ({ done: false, status: "running" }),
    "wizard.next": async () => {
      if (!stepShown) {
        stepShown = true;
        return {
          done: false,
          status: "running",
          step: { id: "credential", type: "text", sensitive: true, message: "Enter your key" },
        };
      }
      const result = await answer.promise;
      saved = result.done && result.status === "done";
      return result;
    },
    "wizard.cancel": () => cancel.promise,
    "wizard.status": () => status.promise,
  };
  request.mockImplementation(async (method: string) =>
    Object.hasOwn(responses, method) ? responses[method]!() : originalRequest(method),
  );
  context.runtimeConfig.runExternalMutation = async (task, mutationOptions) => {
    if (mutationOptions?.canDispatch?.() === false) {
      return { ok: false, reason: "rejected", error: "Sign-in owner changed" };
    }
    const value = await task(context.gateway.snapshot.client!);
    return { ok: true, value, refresh: { ok: true } };
  };
  return { ...harness, answer, cancel, status };
}

async function clickEnabled(page: ModelProvidersPageTestElement, selector: string) {
  const button = () => page.querySelector<HTMLButtonElement>(selector);
  await waitForSolid(() => expect(button()?.disabled).toBe(false));
  button()!.click();
  await page.updateComplete;
}

export async function openPicker(page: ModelProvidersPageTestElement) {
  await waitForProviders(page);
  await clickEnabled(page, "[data-models-connect]");
}

export async function selectProvider(page: ModelProvidersPageTestElement, provider: string) {
  await clickEnabled(page, `[data-models-login-provider="${provider}"]`);
}

export async function chooseLogin(page: ModelProvidersPageTestElement, label = "Example API key") {
  await openPicker(page);
  await selectProvider(page, "example");
  clickLoginChoice(page, label);
}

export async function openLogin(page: ModelProvidersPageTestElement, label = "Example API key") {
  await openPicker(page);
  await selectProvider(page, "example");
  await startSelectedLogin(page, label);
}
