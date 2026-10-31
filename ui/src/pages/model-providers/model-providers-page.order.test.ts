/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelsAuthLogoutParams,
  ModelsAuthOrderSetParams,
} from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusProfile, WizardNextResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import {
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../../test-helpers/modal-dialog.ts";
import "../../lib/toast-host.tsx";
import {
  waitForText,
  loginOption,
  capability,
  expectAbsent,
  expectPresent,
  profile as authProfile,
  click,
  expectDisabled,
  expectContent,
} from "../../test-helpers/model-providers.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  drainPageUpdates,
  mountPage,
  unmountPage,
  createAuthStatus,
  createHarness,
  expandProvider,
  waitForProviders,
  requestCount,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
  submitCredential,
} from "./model-providers-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage profile actions", () => {
  it("refreshes uncertain status after a committed Reset", async () => {
    const profileIds = null;

    const shell = document.createElement("div");
    shell.className = "shell";
    document.body.append(shell);
    const toast = shell.appendChild(document.createElement("openclaw-toast-host"));
    const { context, request } = createHarness("main");

    const originalRequest = request.getMockImplementation()!;
    const warning = "Profile priority saved, but live authentication status could not refresh.";
    let committed = false;
    request.mockImplementation(async (method: string) => {
      if (method === "models.authOrderSet") {
        committed = true;
        return { provider: "openai", profileIds, warning };
      }
      if (method === "models.authStatus") {
        return committed
          ? {
              ts: 2,
              providers: [],
              unavailable: {
                code: "PREPARED_MODEL_AUTH_UNAVAILABLE",
                message: "Account status unavailable",
              },
            }
          : createAuthStatus([
              {
                profileOrder: ["openai:one", "openai:two"],
                profileOrderStored: true,
              },
            ]);
      }
      return originalRequest(method);
    });
    const page = appendPage(context);
    await expandProvider(page, "openai");
    await waitForSolid(() =>
      expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2),
    );

    page.view.props.onProfileOrderChange("openai", "openai", profileIds);

    await waitForSolid(() => {
      expect(page.view.props.authStatus?.unavailable?.code).toBe("PREPARED_MODEL_AUTH_UNAVAILABLE");
      expect(toast.toast?.message).toBe(warning);
    });
    await toast.updateComplete;
    await vi.dynamicImportSettled();
    await waitForSolid(() => expect(toast.textContent).toContain(warning));
    expect(page.view.props.profileOrders.openai).toBeUndefined();
    expectAbsent(page, 'li.provider-row[data-provider-id="openai"]');
    expectAbsent(page, ".model-providers__profile");
  });

  it("keeps the latest queued order through paused and resumed configuration work", async () => {
    const { context, notifyRuntimeConfig, request, runtimeConfig } = createHarness("main");
    const page = appendPage(context);
    await waitForProviders(page);
    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet" && requestCount(request, method) === 1) {
        return firstSave.promise;
      }
      void params;
      return originalRequest(method);
    });

    page.view.props.onProfileOrderChange("openai", "openai", ["openai:two", "openai:one"]);
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(1));
    page.view.props.onProfileOrderChange("openai", "openai", ["openai:one", "openai:two"]);
    expect(page.view.props.profileOrders.openai).toEqual(["openai:one", "openai:two"]);
    expect(requestCount(request, "models.authOrderSet")).toBe(1);
    runtimeConfig.state.configSaving = true;
    notifyRuntimeConfig();
    firstSave.resolve({});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(requestCount(request, "models.authOrderSet")).toBe(1);
    expect(page.view.props.profileOrders.openai).toEqual(["openai:one", "openai:two"]);

    runtimeConfig.state.configSaving = false;
    notifyRuntimeConfig();
    await vi.waitFor(() => expect(requestCount(request, "models.authOrderSet")).toBe(2));
    await vi.waitFor(() => expect(page.view.props.profileOrders.openai).toBeUndefined());
    expect(request.mock.calls.findLast(([method]) => method === "models.authOrderSet")).toEqual([
      "models.authOrderSet",
      { provider: "openai", profileIds: ["openai:one", "openai:two"], agentId: "main" },
    ]);
  });

  it("discards a detached page's queued order before a replacement page saves", async () => {
    const { context, request, publishEvent } = createHarness("main");

    const originalRequest = request.getMockImplementation()!;
    const firstSave = deferred<unknown>();
    let savedOrder = ["openai:one", "openai:two", "openai:three"];
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authOrderSet") {
        savedOrder = [...((params as ModelsAuthOrderSetParams).profileIds ?? [])];
        publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
        return requestCount(request, method) === 1 ? firstSave.promise : {};
      }
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            profiles: ["openai:one", "openai:two", "openai:three"].map((profileId) =>
              authProfile(profileId),
            ),
            profileOrder: [...savedOrder],
            profileOrderStored: true,
          },
        ]);
      }
      return originalRequest(method);
    });
    const rows = (page: ModelProvidersPageTestElement) =>
      [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
        (row) => row.dataset.profileId,
      );
    const moveFirstAccount = (page: ModelProvidersPageTestElement, direction: "up" | "down") => {
      const grip = page.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:one"] .model-providers__profile-grip',
      )!;
      expect(grip.disabled).toBe(false);
      grip.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: direction === "up" ? "ArrowUp" : "ArrowDown",
          bubbles: true,
        }),
      );
    };
    const oldPage = appendPage(context);
    await waitForProviders(oldPage);
    await expandProvider(oldPage, "openai");
    await waitForSolid(() => expect(rows(oldPage)).toHaveLength(3));
    moveFirstAccount(oldPage, "down");
    await oldPage.updateComplete;
    moveFirstAccount(oldPage, "down");
    await oldPage.updateComplete;
    expect(rows(oldPage)).toEqual(["openai:two", "openai:three", "openai:one"]);
    expect(requestCount(request, "models.authOrderSet")).toBe(1);

    unmountPage(oldPage);
    const replacementPage = appendPage(context);
    await waitForProviders(replacementPage);
    await expandProvider(replacementPage, "openai");
    await waitForSolid(() =>
      expect(rows(replacementPage)).toEqual(["openai:two", "openai:one", "openai:three"]),
    );
    moveFirstAccount(replacementPage, "up");
    await waitForSolid(() =>
      expect(replacementPage.view.props.profileOrders.openai).toBeUndefined(),
    );
    expect(savedOrder).toEqual(["openai:one", "openai:two", "openai:three"]);

    // The first write already reached the server; only its response is delayed.
    // Let its continuation finish before checking for an obsolete queued write.
    firstSave.resolve({});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(savedOrder).toEqual(["openai:one", "openai:two", "openai:three"]);
    expect(requestCount(request, "models.authOrderSet")).toBe(2);
    expect(rows(replacementPage)).toEqual(["openai:one", "openai:two", "openai:three"]);
  });

  it("cancels safely and logs out only the confirmed account's credential owner", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const { settingsAgentSelection, context, notifySelection, publishPhase, request } =
      createHarness("writer");

    const originalRequest = request.getMockImplementation()!;
    const logout = deferred();
    let failLogout = true;
    let profiles: ModelAuthStatusProfile[] = [
      authProfile("work", { email: "work@example.com", logoutSupported: true }),
      authProfile("personal", { email: "personal@example.com", logoutSupported: true }),
    ];
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "models.authStatus") {
        return createAuthStatus([
          {
            provider: "claude-cli",
            authProvider: "anthropic",
            displayName: "Claude",
            profiles,
          },
        ]);
      }
      if (method === "models.authLogout") {
        if (failLogout) {
          failLogout = false;
          throw new Error("The account could not be logged out");
        }
        await logout.promise;
        const { profileIds } = params as ModelsAuthLogoutParams;
        profiles = profiles.filter((profile) => !profileIds?.includes(profile.profileId));
        return { warning: "Authentication refresh failed." };
      }
      return originalRequest(method);
    });
    const shell = document.body.appendChild(document.createElement("div"));
    shell.className = "shell";
    const toast = shell.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    try {
      const openConfirmation = async () => {
        // Separate user clicks so the previous confirmation can settle.
        await nextFrame();
        await waitForProviders(page);
        await expandProvider(page, "anthropic");
        await waitForSolid(() =>
          expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2),
        );
        click(page, '[aria-label="Log out work@example.com"]');
        await page.updateComplete;
        return getRenderedModalDialog(document.body);
      };
      const { modal: initialModal, dialog } = await openConfirmation();
      let modal = initialModal;
      expect(page.renderRoot.contains(modal)).toBe(false);
      expect(dialog.getAttribute("aria-label")).toBe("Log out work@example.com");
      expectContent(modal, ["work@example.com"]);
      expect(requestCount(request, "models.authLogout")).toBe(0);
      click(modal, "button[autofocus]");
      await page.updateComplete;
      expectAbsent(document.body, "openclaw-modal-dialog");
      expect(requestCount(request, "models.authLogout")).toBe(0);
      expect(
        [...page.querySelectorAll<HTMLButtonElement>(".model-providers__profile-logout")].every(
          (button) => !button.disabled,
        ),
      ).toBe(true);

      for (const invalidate of [
        () => {
          settingsAgentSelection.state.selectedId = "main";
          notifySelection();
        },
        () => publishPhase("connecting"),
        () => unmountPage(page),
      ]) {
        ({ modal } = await openConfirmation());
        const confirm = modal.querySelector<HTMLButtonElement>("button.danger")!;
        invalidate();
        await waitForSolid(() => expectAbsent(document.body, "openclaw-modal-dialog"));
        confirm.click();
        expect(requestCount(request, "models.authLogout")).toBe(0);
        settingsAgentSelection.state.selectedId = "writer";
        notifySelection();
        publishPhase("connected");
        if (!page.isConnected) {
          mountPage(page);
        }
        await page.updateComplete;
      }

      ({ modal } = await openConfirmation());
      click(modal, "button.danger");
      await waitForSolid(() =>
        expect(toast.textContent).toContain("The account could not be logged out"),
      );
      expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2);
      expectAbsent(document.body, "openclaw-modal-dialog");
      expect(requestCount(request, "models.authLogout")).toBe(1);
      await waitForSolid(() =>
        expectDisabled(page, '[aria-label="Log out work@example.com"]', false),
      );

      ({ modal } = await openConfirmation());
      expectAbsent(modal, '[role="alert"]');
      click(modal, "button.danger");
      await waitForSolid(() => expect(requestCount(request, "models.authLogout")).toBe(2));
      await page.updateComplete;
      expect(request).toHaveBeenCalledWith("models.authLogout", {
        provider: "claude-cli",
        profileIds: ["work"],
        agentId: "writer",
      });
      expectAbsent(document.body, "openclaw-modal-dialog");
      expect(
        [...page.querySelectorAll<HTMLButtonElement>(".model-providers__profile-logout")].every(
          (button) => button.disabled,
        ),
      ).toBe(true);
      logout.resolve();
      await waitForSolid(() =>
        expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(1),
      );
      expect(requestCount(request, "models.authLogout")).toBe(2);
      await waitForSolid(() =>
        expectDisabled(page, '[aria-label="Log out personal@example.com"]', false),
      );
      expect(
        [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
          (row) => row.dataset.profileId,
        ),
      ).toEqual(["personal"]);
      await toast.updateComplete;
      expectContent(toast.querySelector('[role="status"]'), ["Logged out."]);
      await waitForSolid(() => expectContent(toast, ["Authentication refresh failed."]));
      expect(context.runtimeConfig.patch).not.toHaveBeenCalled();
    } finally {
      logout.resolve();
      unmountPage(page);
      restoreDialogPolyfill();
    }
  });
});

function accountRecoveryHarness(
  initialAccount: "original" | "replacement" | "unavailable" = "original",
  source: "saved" | "inherited" = "saved",
) {
  const harness = createHarness("writer");
  const originalRequest = harness.request.getMockImplementation()!;
  const modelRef = "example/selected-model";
  const profile = (id: string): ModelAuthStatusProfile =>
    authProfile(`example:${id}`, { source, email: `${id}@example.invalid`, logoutSupported: true });
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
            capability("example", {
              loginOptions: [
                loginOption("example-browser", "example", "Example browser sign-in", "oauth", {
                  featured: true,
                }),
              ],
            }),
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
  expectContent(account, ["replacement@example.invalid"]);
  const use = account.querySelector<HTMLButtonElement>("[data-models-use-account]");
  expect(use?.disabled).toBe(false);
  use!.click();
  await waitForText(page, "openclaw-modal-dialog", "Checking your model setup");
}

describe("Models account recovery", () => {
  it("recovers a removed selected account only after explicitly activating its inherited replacement", async () => {
    const source = "inherited";

    const restoreDialog = installDialogPolyfill();
    const { context, request, runtimeConfig, modelRef, login, activation } = accountRecoveryHarness(
      "original",
      source,
    );
    const page = appendPage(context);
    try {
      await waitForProviders(page);
      expectAbsent(page, "[data-models-account-recovery]");
      await expandProvider(page, "example");
      click(page, '[aria-label="Log out original@example.invalid"]');
      await page.updateComplete;
      const { modal } = await getRenderedModalDialog(document.body);
      click(modal, "button.danger");
      await waitForSolid(() =>
        expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(0),
      );
      expect(request).toHaveBeenCalledWith("models.authLogout", {
        provider: "example",
        profileIds: ["example:original"],
        agentId: "writer",
      });
      const recovery = page.querySelector("[data-models-account-recovery]");
      expectContent(recovery, [modelRef]);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();

      await openAccountRecovery(page);
      expectAbsent(page, "[data-models-use-account]");
      await startSelectedLogin(page, "Example browser sign-in");
      await submitCredential(page);
      login.resolve({ done: true, status: "done" });
      await waitForSolid(() =>
        expect(page.renderRoot.textContent).toContain("Provider credentials saved."),
      );
      const close = [
        ...page.querySelectorAll<HTMLButtonElement>(".model-setup-wizard button"),
      ].find((button) => button.textContent?.trim() === "Close");
      expect(close).toBeDefined();
      close!.click();
      await page.updateComplete;
      expectPresent(page, "[data-models-account-recovery]");
      expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
        agents: { entries: { writer: { model: `${modelRef}@example:original` } } },
      });
      expect(requestCount(request, "openclaw.setup.activate.start")).toBe(0);

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
      await waitForSolid(() => {
        expectAbsent(page, "openclaw-modal-dialog");
        expectAbsent(page, "[data-models-account-recovery]");
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
      unmountPage(page);
      restoreDialog();
    }
  });

  it.each(["cancel", "selection change"] as const)(
    "blocks queued account activation after %s",
    async (outcome) => {
      const restoreDialog = outcome === "cancel" ? installDialogPolyfill() : () => {};
      const h = accountRecoveryHarness("replacement");
      const waiting = deferred();
      const release = deferred();
      const page = appendPage(h.context);
      const newSelection = h.modelRef + "@example:chosen-elsewhere";
      try {
        await openAccountRecovery(page);
        h.runtimeConfig.beforeExternalDispatch.mockImplementation(async () => {
          waiting.resolve();
          await release.promise;
        });
        click(page, "[data-models-use-account]");
        await waiting.promise;
        if (outcome === "cancel") {
          await waitForText(page, "openclaw-modal-dialog", "Checking your model setup");
          click(page, ".model-setup-wizard__footer button");
          await waitForSolid(() => expectAbsent(page, "openclaw-modal-dialog"));
        } else {
          h.setConfiguredModel(newSelection);
          await h.runtimeConfig.refresh();
        }
        release.resolve();
        if (outcome === "selection change") {
          await waitForSolid(() =>
            expect(page.querySelector("openclaw-modal-dialog [role=alert]")?.textContent).toMatch(
              /changed/i,
            ),
          );
        }
        await drainPageUpdates(page);
        expect(requestCount(h.request, "openclaw.setup.activate.start")).toBe(0);
        expect(currentConfigObject(h.runtimeConfig.state)).toMatchObject({
          agents: {
            entries: {
              writer: {
                model: outcome === "cancel" ? h.modelRef + "@example:original" : newSelection,
              },
            },
          },
        });
        expect(h.runtimeConfig.patch).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        h.activation.resolve({ done: true, status: "cancelled" });
        unmountPage(page);
        restoreDialog();
      }
    },
  );

  it.each(["cancel", "missing receipt"] as const)(
    "keeps the unavailable selection visible after account activation %s",
    async (outcome) => {
      const { context, request, runtimeConfig, modelRef, activation } =
        accountRecoveryHarness("replacement");
      const page = appendPage(context);
      await useReplacementAccount(page);
      if (outcome === "cancel") {
        await waitForSolid(() => {
          expect(requestCount(request, "wizard.next")).toBe(1);
          expectPresent(page, ".model-setup-wizard__footer button");
        });
        click(page, ".model-setup-wizard__footer button");
        await waitForSolid(() => expectAbsent(page, "openclaw-modal-dialog"));
        expect(requestCount(request, "wizard.cancel")).toBeGreaterThan(0);
      } else {
        activation.resolve({ done: true, status: "done" });
        await waitForSolid(() => expectPresent(page, "openclaw-modal-dialog [role=alert]"));
      }
      expectContent(page.querySelector("[data-models-account-recovery]"), [modelRef]);
      expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
        agents: { entries: { writer: { model: `${modelRef}@example:original` } } },
      });
      expectContent(page.renderRoot, [], ["Provider credentials saved."]);
    },
  );

  it("does not treat an unavailable credential inventory as a removed account", async () => {
    const { context } = accountRecoveryHarness("unavailable");
    const page = appendPage(context);
    await waitForProviders(page);
    expect(page.view.props.authStatus?.unavailable).toBeDefined();
    expectAbsent(page, "[data-models-account-recovery]");
  });

  it("offers only compatible accounts for minimax-portal-cn when the display card combines auth owners", async () => {
    const modelProvider = "minimax-portal-cn";

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
                  authProfile("minimax-portal:replacement", {
                    source: "saved",
                    email: "replacement@example.invalid",
                  }),
                ],
              },
              {
                provider: "minimax",
                authProvider: "minimax",
                displayName: "MiniMax",
                status: "static",
                profiles: [
                  authProfile("minimax:api-key", {
                    source: "saved",
                    type: "api_key",
                    status: "static",
                    displayName: "API key account",
                  }),
                ],
              },
            ],
            providerCapabilities: [
              capability("minimax", {
                apiKeySupported: true,
                quickApiKeySetup: true,
                loginOptions: [loginOption("minimax-key", "minimax", "MiniMax API key", "secret")],
              }),
              capability("minimax-portal", {
                loginOptions: [
                  loginOption(
                    "minimax-login",
                    "minimax-portal",
                    "MiniMax browser sign-in",
                    "oauth",
                    { featured: true },
                  ),
                ],
              }),
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
    click(page, '[data-models-login-provider="minimax-portal"]');
    await page.updateComplete;
    const dialog = page.querySelector("openclaw-modal-dialog")!;
    expectContent(dialog, ["MiniMax browser sign-in"]);
    const account = dialog.querySelector('[data-profile-id="minimax-portal:replacement"]')!;
    expectContent(account, ["replacement@example.invalid"]);
    expectDisabled(account, "[data-models-use-account]", false);
    const incompatible = dialog.querySelector('[data-profile-id="minimax:api-key"]')!;
    expectContent(incompatible, ["API key account"]);
    expectAbsent(incompatible, "[data-models-use-account]");
  });
});
