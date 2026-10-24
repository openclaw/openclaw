/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModelsAuthLogoutParams,
  ModelsAuthOrderSetParams,
} from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusProfile, WizardNextResult } from "../../api/types.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import "../../lib/toast-host.tsx";
import {
  getRenderedModalDialog,
  installDialogPolyfill,
  nextFrame,
} from "../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import {
  appendPage,
  openApiKeyProvider,
  drainPageUpdates,
  publishRouteData,
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
    const { context, request, snapshot } = createHarness("main");
    snapshot.hello = {
      ...snapshot.hello,
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
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
    expect(page.view.props.authStatus?.providers).toEqual([]);
    expect(page.querySelector('li.provider-row[data-provider-id="openai"]')).toBeNull();
    expect(page.querySelector(".model-providers__profile")).toBeNull();
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
    expect(page.view.props.messages.openai).toBeUndefined();
  });

  it("discards a detached page's queued order before a replacement page saves", async () => {
    const { context, request, snapshot, publishEvent } = createHarness("main");
    snapshot.hello = {
      ...snapshot.hello,
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
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
            profiles: ["openai:one", "openai:two", "openai:three"].map((profileId) => ({
              profileId,
              type: "oauth",
              status: "ok",
            })),
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
    const { settingsAgentSelection, context, notifySelection, publishPhase, request, snapshot } =
      createHarness("writer");
    snapshot.hello = {
      ...snapshot.hello,
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.admin"] },
    };
    const originalRequest = request.getMockImplementation()!;
    const logout = deferred();
    let failLogout = true;
    let profiles: ModelAuthStatusProfile[] = [
      {
        profileId: "work",
        type: "oauth",
        status: "ok",
        email: "work@example.com",
        logoutSupported: true,
      },
      {
        profileId: "personal",
        type: "oauth",
        status: "ok",
        email: "personal@example.com",
        logoutSupported: true,
      },
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
        return {};
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
        page.querySelector<HTMLButtonElement>('[aria-label="Log out work@example.com"]')!.click();
        await page.updateComplete;
        return getRenderedModalDialog(document.body);
      };
      const { modal: initialModal, dialog } = await openConfirmation();
      let modal = initialModal;
      expect(page.renderRoot.contains(modal)).toBe(false);
      expect(dialog.getAttribute("aria-label")).toBe("Log out work@example.com");
      expect(modal.textContent).toContain("work@example.com");
      expect(requestCount(request, "models.authLogout")).toBe(0);
      modal.querySelector<HTMLButtonElement>("button[autofocus]")!.click();
      await page.updateComplete;
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
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
        await waitForSolid(() =>
          expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull(),
        );
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
      modal.querySelector<HTMLButtonElement>("button.danger")!.click();
      await waitForSolid(() =>
        expect(toast.textContent).toContain("The account could not be logged out"),
      );
      expect(page.querySelectorAll(".model-providers__profile")).toHaveLength(2);
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(page.querySelector(".model-providers__row > .callout")).toBeNull();
      expect(page.view.props.messages.anthropic).toBeUndefined();
      expect(requestCount(request, "models.authLogout")).toBe(1);
      await waitForSolid(() =>
        expect(
          page.querySelector<HTMLButtonElement>('[aria-label="Log out work@example.com"]')
            ?.disabled,
        ).toBe(false),
      );

      ({ modal } = await openConfirmation());
      expect(modal.querySelector('[role="alert"]')).toBeNull();
      modal.querySelector<HTMLButtonElement>("button.danger")!.click();
      await waitForSolid(() => expect(requestCount(request, "models.authLogout")).toBe(2));
      await page.updateComplete;
      expect(request).toHaveBeenCalledWith("models.authLogout", {
        provider: "claude-cli",
        profileIds: ["work"],
        agentId: "writer",
      });
      expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull();
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
        expect(
          page.querySelector<HTMLButtonElement>('[aria-label="Log out personal@example.com"]')
            ?.disabled,
        ).toBe(false),
      );
      expect(
        [...page.querySelectorAll<HTMLElement>(".model-providers__profile")].map(
          (row) => row.dataset.profileId,
        ),
      ).toEqual(["personal"]);
      await toast.updateComplete;
      expect(toast.isConnected).toBe(true);
      expect(toast.parentElement).toBe(shell);
      expect(toast.querySelector(".app-toast--bottom .app-toast__icon")).not.toBeNull();
      expect(toast.querySelector('[role="status"]')?.textContent).toContain("Logged out.");
      expect(page.querySelector(".model-providers__row > .callout")).toBeNull();
      expect(page.view.props.messages.anthropic).toBeUndefined();
    } finally {
      logout.resolve();
      unmountPage(page);
      restoreDialogPolyfill();
    }
  });
  it("ignores logout completion when route data changes the selected agent", async () => {
    const { settingsAgentSelection, context, request, runtimeConfig } = createHarness("main");
    const restoreDialogs = installDialogPolyfill();
    const toast = document.body.appendChild(document.createElement("openclaw-toast-host"));
    const page = appendPage(context);
    await waitForProviders(page);
    const firstLogout = deferred<unknown>();
    const defaultsSave = deferred();
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method, params?: { provider?: string }) => {
      if (method === "models.authLogout") {
        return firstLogout.promise;
      }
      if (method === "models.probe") {
        if (params?.provider === "anthropic") {
          throw new Error("Previous agent failure");
        }
        return { provider: "openai", status: "ok", results: [] };
      }
      return originalRequest(method);
    });
    try {
      page.view.props.onProbe("openai", ["openai"]);
      await waitForSolid(() => expect(page.view.props.probeResults.openai).toBeDefined());
      page.view.props.onProbe("anthropic", ["anthropic"]);
      await waitForSolid(() =>
        expect(page.view.props.messages.anthropic?.text).toBe("Previous agent failure"),
      );
      page.view.props.onOpenKeyEditor("openai");
      page.view.props.onKeyDraftChange("synthetic-route-agent-key");
      await openApiKeyProvider(page, "anthropic");
      page.view.props.onAddProviderKeyChange("synthetic-route-provider-key");
      runtimeConfig.ensureLoaded.mockImplementationOnce(() => defaultsSave.promise);
      page.view.props.onPrimaryChange("openai/gpt-5");
      page.view.props.onRequestLogout({
        cardId: "openai",
        label: "OpenAI",
        target: { provider: "openai", profileIds: ["openai:first"] },
      });
      await waitForSolid(() =>
        expect(document.body.querySelector(".exec-approval-actions button.danger")).not.toBeNull(),
      );
      // The unrelated defaults write stays held while this confirmation opens.
      await drainPageUpdates(page);
      expect(page.view.props.busy.defaults).toBe(true);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      document.body
        .querySelector<HTMLButtonElement>(".exec-approval-actions button.danger")!
        .click();
      await waitForSolid(() => expect(requestCount(request, "models.authLogout")).toBe(1));
      settingsAgentSelection.state.selectedId = "writer";
      settingsAgentSelection.state.scopeId = "writer";
      publishRouteData(page, { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 });
      await page.updateComplete;
      expect(page.view.props.credentialAgentLabel).toBe("Writer");
      expect(page.view.props.busy).toEqual({});
      expect(page.view.props.messages).toEqual({});
      expect(page.view.props.probeResults).toEqual({});
      expect(page.view.props.keyEditorProvider).toBeNull();
      expect(page.view.props.keyDraft).toBe("");
      expect(page.view.props.addProviderOpen).toBe(false);
      expect(page.view.props.addProviderId).toBe("");
      expect(page.view.props.addProviderKey).toBe("");
      expect(page.view.props.defaultModels.primary).toBe("openai/gpt-5");
      firstLogout.resolve({});
      await drainPageUpdates(page);
      expect(requestCount(request, "models.authLogout")).toBe(1);
      await toast.updateComplete;
      expect(toast.querySelector('[role="status"]')).toBeNull();
    } finally {
      firstLogout.resolve({});
      defaultsSave.resolve();
      unmountPage(page);
      restoreDialogs();
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
  await waitForSolid(() =>
    expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
      "Checking your model setup",
    ),
  );
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
      expect(page.querySelector("[data-models-account-recovery]")).toBeNull();
      await expandProvider(page, "example");
      page
        .querySelector<HTMLButtonElement>('[aria-label="Log out original@example.invalid"]')!
        .click();
      await page.updateComplete;
      const { modal } = await getRenderedModalDialog(document.body);
      modal.querySelector<HTMLButtonElement>("button.danger")!.click();
      await waitForSolid(() =>
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
      await waitForSolid(() => {
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
      unmountPage(page);
      restoreDialog();
    }
  });

  it("cancels account recovery while config admission is queued without dispatching activation", async () => {
    const restoreDialog = installDialogPolyfill();
    const { context, request, runtimeConfig, modelRef } = accountRecoveryHarness("replacement");
    const waiting = deferred();
    const release = deferred();
    const page = appendPage(context);
    try {
      await openAccountRecovery(page);
      runtimeConfig.beforeExternalDispatch.mockImplementation(async () => {
        waiting.resolve();
        await release.promise;
      });
      page.querySelector<HTMLButtonElement>("[data-models-use-account]")!.click();
      await waiting.promise;
      await waitForSolid(() =>
        expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
          "Checking your model setup",
        ),
      );
      page.querySelector<HTMLButtonElement>(".model-setup-wizard__footer button")!.click();
      await waitForSolid(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
      release.resolve();
      await drainPageUpdates(page);
      expect(
        request.mock.calls.some(([method]) => method === "openclaw.setup.activate.start"),
      ).toBe(false);
      expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
        agents: { entries: { writer: { model: `${modelRef}@example:original` } } },
      });
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      unmountPage(page);
      restoreDialog();
    }
  });

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
          expect(page.querySelector(".model-setup-wizard__footer button")).not.toBeNull();
        });
        page.querySelector<HTMLButtonElement>(".model-setup-wizard__footer button")!.click();
        await waitForSolid(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
        expect(request.mock.calls.some(([method]) => method === "wizard.cancel")).toBe(true);
      } else {
        activation.resolve({ done: true, status: "done" });
        await waitForSolid(() =>
          expect(page.querySelector("openclaw-modal-dialog [role=alert]")).not.toBeNull(),
        );
      }
      expect(page.querySelector("[data-models-account-recovery]")?.textContent).toContain(modelRef);
      expect(currentConfigObject(runtimeConfig.state)).toMatchObject({
        agents: { entries: { writer: { model: `${modelRef}@example:original` } } },
      });
      expect(page.renderRoot.textContent).not.toContain("Provider credentials saved.");
    },
  );

  it("does not treat an unavailable credential inventory as a removed account", async () => {
    const { context } = accountRecoveryHarness("unavailable");
    const page = appendPage(context);
    await waitForProviders(page);
    expect(page.view.props.authStatus?.unavailable).toBeDefined();
    expect(page.querySelector("[data-models-account-recovery]")).toBeNull();
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
    page.querySelector<HTMLButtonElement>('[data-models-login-provider="minimax-portal"]')!.click();
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
  });

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
      await waitForSolid(() =>
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
      unmountPage(page);
    }
  });
});
