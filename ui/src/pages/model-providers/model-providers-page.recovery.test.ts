/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusProfile, WizardNextResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  appendPage,
  createHarness,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
  submitCredential,
  waitForProviders,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function accountRecoveryHarness(
  initialAccount: "original" | "replacement" | "unavailable" = "original",
  source: "saved" | "inherited" = "saved",
) {
  const harness = createHarness("writer");
  const originalRequest = harness.request.getMockImplementation()!;
  const modelRef = "example/selected-model";
  const profile = (id: string): ModelAuthStatusProfile => ({
    profileId: `example:${id}`,
    type: "oauth",
    status: "ok",
    source,
    email: `${id}@example.invalid`,
    logoutSupported: true,
  });
  let profiles = initialAccount === "unavailable" ? [] : [profile(initialAccount)];
  let configuredModel = `${modelRef}@example:original`;
  let activating = false;
  let loginStepShown = false;
  const login = deferred<WizardNextResult>();
  const activation = deferred<WizardNextResult>();
  harness.request.mockImplementation(async (method: string) => {
    switch (method) {
      case "config.get":
        return {
          config: {
            agents: {
              defaults: { model: "other/default-model" },
              entries: { writer: { model: configuredModel } },
            },
          },
          hash: configuredModel,
          valid: true,
        };
      case "models.authStatus":
        return {
          ts: 1,
          providers: [{ provider: "example", displayName: "Example", status: "ok", profiles }],
          ...(initialAccount === "unavailable"
            ? {
                unavailable: {
                  code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
                  message: "Credential inventory is not ready.",
                },
              }
            : {}),
          providerCapabilities: [
            {
              provider: "example",
              apiKeySupported: false,
              quickApiKeySetup: false,
              loginOptions: [
                {
                  id: "example-browser",
                  brandId: "example",
                  label: "Example browser sign-in",
                  kind: "oauth",
                  featured: true,
                },
              ],
            },
          ],
        };
      case "models.authLogout":
        profiles = [];
        return { provider: "example", removedProfiles: ["example:original"], abortedRunIds: [] };
      case "models.authLogin":
        return { done: false, status: "running" };
      case "openclaw.setup.activate.start":
        activating = true;
        return { done: false, status: "running" };
      case "wizard.next":
        if (activating) {
          const result = await activation.promise;
          if (result.modelActivation) {
            configuredModel = `${modelRef}@example:replacement`;
          }
          return result;
        }
        if (!loginStepShown) {
          loginStepShown = true;
          return {
            done: false,
            status: "running",
            step: { id: "credential", type: "text", sensitive: true, message: "Finish sign-in" },
          };
        }
        return login.promise.then((result) => {
          if (result.done && result.status === "done") {
            profiles = [profile("replacement")];
          }
          return result;
        });
      case "wizard.cancel":
        activation.resolve({ done: true, status: "cancelled" });
        return { status: "cancelled" };
      case "wizard.status":
        return { status: "cancelled" };
      default:
        return originalRequest(method);
    }
  });
  return {
    ...harness,
    modelRef,
    login,
    activation,
    setConfiguredModel: (model: string) => {
      configuredModel = model;
    },
  };
}

async function openAccountRecovery(page: ModelProvidersPageTestElement) {
  await waitForProviders(page);
  const recover = page.querySelector<HTMLButtonElement>("[data-models-recover-account]");
  expect(recover?.disabled).toBe(false);
  recover!.click();
  await page.updateComplete;
}

async function useReplacementAccount(page: ModelProvidersPageTestElement) {
  await openAccountRecovery(page);
  const account = page.querySelector(
    'openclaw-modal-dialog [data-profile-id="example:replacement"]',
  )!;
  expect(account.textContent).toContain("replacement@example.invalid");
  const use = account.querySelector<HTMLButtonElement>("[data-models-use-account]");
  expect(use?.disabled).toBe(false);
  use!.click();
  await waitForFast(() =>
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Checking your model setup",
    ),
  );
}

describe("Models account recovery", () => {
  it.each(["saved", "inherited"] as const)(
    "recovers a removed selected account only after explicitly activating its %s replacement",
    async (source) => {
      const restoreDialog = installDialogPolyfill();
      const { context, request, runtimeConfig, modelRef, login, activation } =
        accountRecoveryHarness("original", source);
      const page = appendPage(context);
      try {
        await waitForProviders(page);
        expect(page.querySelector("[data-models-account-recovery]")).toBeNull();
        page
          .querySelector<HTMLButtonElement>('[aria-label="Log out original@example.invalid"]')!
          .click();
        await page.updateComplete;
        const { modal } = await getRenderedModalDialog(document.body);
        modal.querySelector<HTMLButtonElement>("button.danger")!.click();
        await waitForFast(() =>
          expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(0),
        );
        expect(request).toHaveBeenCalledWith("models.authLogout", {
          provider: "example",
          profileIds: ["example:original"],
          agentId: "writer",
        });
        const recovery = page.querySelector("[data-models-account-recovery]");
        expect(recovery?.textContent).toContain(modelRef);
        expect(runtimeConfig.patch).not.toHaveBeenCalled();

        await openAccountRecovery(page);
        expect(page.querySelector("[data-models-use-account]")).toBeNull();
        await startSelectedLogin(page, "example-browser");
        await submitCredential(page);
        login.resolve({ done: true, status: "done" });
        await waitForFast(() => expect(page.textContent).toContain("Provider credentials saved."));
        expect(page.querySelector("[data-models-account-recovery]")).not.toBeNull();
        expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
          agents: { entries: { writer: { model: `${modelRef}@example:original` } } },
        });
        expect(
          request.mock.calls.some(([method]) => method === "openclaw.setup.activate.start"),
        ).toBe(false);

        await useReplacementAccount(page);
        expect(request).toHaveBeenCalledWith(
          "openclaw.setup.activate.start",
          {
            sessionId: expect.any(String),
            kind: "saved-auth:example%3Areplacement",
            agentId: "writer",
            modelRef,
          },
          { timeoutMs: null },
        );
        activation.resolve({ done: true, status: "done", modelActivation: { modelRef } });
        await waitForFast(() => {
          expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
          expect(page.querySelector("[data-models-account-recovery]")).toBeNull();
        });
        expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
          agents: {
            defaults: { model: "other/default-model" },
            entries: { writer: { model: `${modelRef}@example:replacement` } },
          },
        });
        expect(runtimeConfig.patch).not.toHaveBeenCalled();
        expect(context.navigate).not.toHaveBeenCalled();
      } finally {
        page.remove();
        restoreDialog();
      }
    },
  );

  it.each(["cancel", "failure", "missing receipt"] as const)(
    "keeps the unavailable selection visible after account activation %s",
    async (outcome) => {
      const { context, request, runtimeConfig, modelRef, activation } =
        accountRecoveryHarness("replacement");
      const page = appendPage(context);
      await useReplacementAccount(page);
      if (outcome === "cancel") {
        page.querySelector<HTMLButtonElement>(".model-setup-wizard__footer button")!.click();
        await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(request.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(true);
      } else {
        activation.resolve(
          outcome === "failure"
            ? { done: true, status: "error", error: "Replacement credential was rejected." }
            : { done: true, status: "done" },
        );
        await waitForFast(() =>
          expect(page.querySelector("openclaw-modal-dialog [role=alert]")).not.toBeNull(),
        );
        if (outcome === "failure") {
          expect(page.querySelector("openclaw-modal-dialog [role=alert]")?.textContent).toContain(
            "Replacement credential was rejected.",
          );
        }
      }
      expect(page.querySelector("[data-models-account-recovery]")?.textContent).toContain(modelRef);
      expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
        agents: { entries: { writer: { model: `${modelRef}@example:original` } } },
      });
      expect(page.textContent).not.toContain("Provider credentials saved.");
    },
  );

  it("does not treat an unavailable credential inventory as a removed account", async () => {
    const { context } = accountRecoveryHarness("unavailable");
    const page = appendPage(context);
    await waitForProviders(page);
    expect(page.data?.authStatus?.unavailable).toBeDefined();
    expect(page.querySelector("[data-models-account-recovery]")).toBeNull();
  });

  it.each(["minimax-portal", "minimax-portal-cn"])(
    "offers only compatible accounts for %s when the display card combines auth owners",
    async (modelProvider) => {
      const { context, request, setConfiguredModel } = accountRecoveryHarness("replacement");
      setConfiguredModel(`${modelProvider}/model@minimax-portal:removed`);
      const originalRequest = request.getMockImplementation()!;
      request.mockImplementation(async (method) =>
        method === "models.authStatus"
          ? {
              ts: 1,
              providers: [
                {
                  provider: modelProvider,
                  authProvider: "minimax-portal",
                  displayName: "MiniMax",
                  status: "ok",
                  profiles: [
                    {
                      profileId: "minimax-portal:replacement",
                      source: "saved",
                      type: "oauth",
                      status: "ok",
                      email: "replacement@example.invalid",
                    },
                  ],
                },
                {
                  provider: "minimax",
                  authProvider: "minimax",
                  displayName: "MiniMax",
                  status: "static",
                  profiles: [
                    {
                      profileId: "minimax:api-key",
                      source: "saved",
                      type: "api_key",
                      status: "static",
                      displayName: "API key account",
                    },
                  ],
                },
              ],
              providerCapabilities: [
                {
                  provider: "minimax",
                  apiKeySupported: true,
                  quickApiKeySetup: true,
                  loginOptions: [
                    {
                      id: "minimax-key",
                      brandId: "minimax",
                      label: "MiniMax API key",
                      kind: "secret",
                      featured: false,
                    },
                  ],
                },
                {
                  provider: "minimax-portal",
                  apiKeySupported: false,
                  quickApiKeySetup: false,
                  loginOptions: [
                    {
                      id: "minimax-login",
                      brandId: "minimax-portal",
                      label: "MiniMax browser sign-in",
                      kind: "oauth",
                      featured: true,
                    },
                  ],
                },
              ],
            }
          : originalRequest(method),
      );
      const page = appendPage(context);
      await openAccountRecovery(page);
      expect(
        [...page.querySelectorAll<HTMLElement>("[data-models-login-provider]")]
          .map((provider) => provider.dataset.modelsLoginProvider)
          .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
      ).toEqual(["minimax", "minimax-portal"]);
      page
        .querySelector<HTMLButtonElement>('[data-models-login-provider="minimax-portal"]')!
        .click();
      await page.updateComplete;
      const dialog = page.querySelector("openclaw-modal-dialog")!;
      expect(dialog.textContent).toContain("MiniMax browser sign-in");
      const account = dialog.querySelector('[data-profile-id="minimax-portal:replacement"]')!;
      expect(account.textContent).toContain("replacement@example.invalid");
      expect(account.querySelector<HTMLButtonElement>("[data-models-use-account]")?.disabled).toBe(
        false,
      );
      const incompatible = dialog.querySelector('[data-profile-id="minimax:api-key"]')!;
      expect(incompatible.textContent).toContain("API key account");
      expect(incompatible.querySelector("[data-models-use-account]")).toBeNull();
    },
  );

  it("rejects account recovery when the selected profile changes before activation dispatch", async () => {
    const { context, request, runtimeConfig, modelRef, activation, setConfiguredModel } =
      accountRecoveryHarness("replacement");
    const page = appendPage(context);
    const waiting = deferred();
    const release = deferred();
    try {
      await openAccountRecovery(page);
      runtimeConfig.beforeExternalDispatch.mockImplementation(async () => {
        waiting.resolve();
        await release.promise;
      });
      page.querySelector<HTMLButtonElement>("[data-models-use-account]")!.click();
      await waiting.promise;
      const newSelection = `${modelRef}@example:chosen-elsewhere`;
      setConfiguredModel(newSelection);
      await runtimeConfig.refresh();
      release.resolve();
      await waitForFast(() =>
        expect(page.querySelector("openclaw-modal-dialog [role=alert]")?.textContent).toMatch(
          /changed/i,
        ),
      );
      expect(
        request.mock.calls.some(([method]) => method === "openclaw.setup.activate.start"),
      ).toBe(false);
      expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
        agents: { entries: { writer: { model: newSelection } } },
      });
    } finally {
      release.resolve();
      activation.resolve({ done: true, status: "cancelled" });
      page.remove();
    }
  });
});
