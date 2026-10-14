/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import {
  appendPage,
  createHarness,
  startSelectedLogin,
  submitCredential,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

const authStatus: ModelAuthStatusResult = {
  ts: 1,
  providers: [],
  providerCapabilities: [
    {
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
    },
    {
      provider: "example",
      apiKeySupported: true,
      quickApiKeySetup: false,
      loginOptions: [
        {
          id: "example-browser",
          brandId: "example",
          label: "Example browser",
          kind: "oauth",
          featured: true,
        },
      ],
    },
  ],
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([
  { provider: "meta", choice: "meta/muse-code", setup: true },
  { provider: "example", choice: "example-browser", setup: false },
])(
  "keeps setup-only access scoped while connecting $provider from AI setup",
  async ({ provider, choice, setup }) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request } = createHarness("writer");
    const original = request.getMockImplementation();
    if (!original) {
      throw new Error("Missing Gateway fixture implementation");
    }
    let prompted = false;
    request.mockImplementation(async (method) => {
      if (method === "models.authStatus") {
        return authStatus;
      }
      if (method === "models.authLogin") {
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (prompted) {
          return {
            done: true,
            status: "done",
            ...(setup ? { modelActivation: { modelRef: "meta/muse-spark-1.3" } } : {}),
          };
        }
        prompted = true;
        return {
          done: false,
          status: "running",
          step: { id: "confirmation", type: "text", message: "Confirm native sign-in" },
        };
      }
      return original(method);
    });
    const page = appendPage(context);
    await waitForProviders(page);
    await waitForSolid(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false),
    );
    page.querySelector<HTMLButtonElement>("[data-models-connect]")?.click();
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).not.toContain("Muse Code");
    expect(page.querySelector('[data-models-login-provider="example"]')).not.toBeNull();
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Save credentials for this agent. Choose the active model separately.",
    );

    page.login.reset();
    await page.updateComplete;
    const setupButton = page.querySelector<HTMLButtonElement>("[data-model-readiness] button");
    expect(setupButton).not.toBeNull();
    setupButton?.click();
    await page.updateComplete;
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Choose how to connect.",
    );
    expect(page.querySelector('[data-models-login-provider="meta"]')).not.toBeNull();
    page.querySelector<HTMLButtonElement>(`[data-models-login-provider="${provider}"]`)?.click();
    await page.updateComplete;
    await startSelectedLogin(page, choice);
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      expect.objectContaining({ authChoice: choice, agentId: "writer" }),
      { timeoutMs: null },
    );
    expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(false);
    await submitCredential(page);
    await waitForSolid(() =>
      expect(page.querySelector(".callout.success")?.textContent).toContain(
        t(setup ? "modelProviders.login.activated" : "modelProviders.login.done"),
      ),
    );
  },
);

it("preserves the full model setup picker's manual-provider handoff", async () => {
  const { context } = createHarness("writer");
  const onManualProvider = vi.fn();
  const controller = new ModelProviderLoginController(
    {
      addController: vi.fn(),
      removeController: vi.fn(),
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    },
    {
      getScope: () => ({ context, agentId: "writer", authStatus }),
      canStart: () => true,
      canContinue: () => true,
      refresh: async () => undefined,
      getManualProviders: () => [{ id: "custom-key", label: "Custom key" }],
      onManualProvider,
    },
  );
  await controller.open();
  const picker = controller.pickerView();
  expect(picker?.description).toContain("Choose how to connect.");
  expect(picker?.matches.some((provider) => provider.id === "meta")).toBe(true);
  const manual = picker?.matches.find((provider) => provider.id === "custom-key")?.choices[0];
  if (!picker || !manual) {
    throw new Error("Missing manual provider choice");
  }
  picker.onChoice(manual);
  expect(onManualProvider).toHaveBeenCalledWith("custom-key");
  expect(controller.busy).toBe(false);
});
