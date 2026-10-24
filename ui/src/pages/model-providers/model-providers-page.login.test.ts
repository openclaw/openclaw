/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WizardCancelParams,
  WizardNextParams,
} from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createModelProviderLogin, type ModelProviderLogin } from "./login-controller.ts";
import { ModelProviderLoginView } from "./login-view.tsx";
import {
  loginHarness,
  openPicker,
  selectProvider,
  chooseLogin,
  openLogin,
} from "./model-providers-page.login.test-support.ts";
import {
  requestCount,
  appendPage,
  expandProvider,
  unmountPage,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
  submitCredential,
} from "./model-providers-page.test-support.tsx";
import {
  waitForText,
  loginOption,
  capability as authCapability,
  expectPresent,
  expectAbsent,
  expectDisabled,
  click,
  profile as authProfile,
  expectContent,
} from "./model-providers.test-fixtures.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function searchProviders(page: ModelProvidersPageTestElement, query: string) {
  const input = page.querySelector<HTMLInputElement>("[data-models-login-search]")!;
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  expect(page.querySelector("[data-models-login-search]")).toBe(input);
  expect(document.activeElement).toBe(input);
}

function providerChoices(page: Pick<ParentNode, "querySelectorAll">) {
  return [...page.querySelectorAll<HTMLElement>("[data-models-login-provider]")].map(
    (button) => button.dataset.modelsLoginProvider,
  );
}

function mountLogin(
  context: ReturnType<typeof loginHarness>["context"],
  scope: { agentId: string; authStatus?: ModelAuthStatusResult } = { agentId: "writer" },
  onDiscover?: () => void,
) {
  let controller!: ModelProviderLogin;
  const view = mountSolid(() => {
    controller = createModelProviderLogin({
      getScope: () => ({ context, connectionEpoch: 1, ...scope }),
      canStart: () => true,
      canContinue: () => true,
      refresh: async () => undefined,
      onDiscover,
    });
    return createComponent(ModelProviderLoginView, { controller });
  });
  return { ...view, controller };
}

describe("Models provider login", () => {
  it("connects Muse Code from setup while the account inventory is loading", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer } = loginHarness({
      capabilities: [
        authCapability("meta", {
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            loginOption("meta/muse-code", "meta", "Muse Code", "device-code", {
              featured: true,
              requiresSetup: true,
            }),
          ],
        }),
      ],
    });
    const originalRequest = request.getMockImplementation()!;
    const authStatusReady = deferred();
    request.mockImplementation(async (method, ...args) => {
      if (method === "models.authStatus") {
        await authStatusReady.promise;
      }
      return originalRequest(method, ...args);
    });
    const page = appendPage(context);
    const connect = "[data-model-readiness] button";
    await waitForSolid(() => expectDisabled(page, connect, false));
    expect(page.view.props.loading).toBe(true);
    click(page, connect);
    await page.updateComplete;
    await waitForSolid(() => expectPresent(page, '.model-provider-login [role="status"]'));
    authStatusReady.resolve();
    await selectProvider(page, "meta");
    await startSelectedLogin(page, "Muse Code");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        sessionId: expect.any(String),
        authChoice: "meta/muse-code",
        agentId: "writer",
        selectModel: true,
      },
      { timeoutMs: null },
    );
    const authReads = requestCount(request, "models.authStatus");
    answer.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/muse-spark-1.3" },
    });
    await submitCredential(page);
    await waitForSolid(() =>
      expectContent(page.renderRoot, [
        "Account verified and selected for this agent's default model.",
      ]),
    );
    await waitForSolid(() =>
      expect(requestCount(request, "models.authStatus")).toBeGreaterThan(authReads),
    );
  });

  it("settles browser sign-in even when a manual answer races its terminal response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    const mutate = context.runtimeConfig.runExternalMutation;
    context.runtimeConfig.runExternalMutation = async (task, options) => {
      const result = await mutate(task, options);
      return result.ok && result.value
        ? {
            ...result,
            refresh: { ok: false, error: "Saved sign-in; configuration refresh failed." },
          }
        : result;
    };
    const completed = deferred();
    const manualAbort = new AbortController();
    let session: WizardSession | undefined;
    let purged = false;
    const terminalRead = deferred();
    const terminalDelivery = deferred();
    request.mockImplementation(
      async (method, params?: Partial<WizardNextParams & WizardCancelParams>) => {
        if (method === "models.authLogin") {
          session = new WizardSession(async (prompter) => {
            await prompter.note("Scope: System / agent", "Provider sign-in");
            await prompter.openUrl?.("https://provider.example/sign-in");
            await prompter.note("Open the sign-in page.", "Provider instructions");
            void prompter
              .text({ message: "Paste the redirect URL", signal: manualAbort.signal })
              .catch(() => {});
            await completed.promise;
            manualAbort.abort();
          });
          return { done: false, status: "running" };
        }
        if (method === "wizard.next") {
          if (purged) {
            throw new GatewayRequestError({
              code: "INVALID_REQUEST",
              message: "Wizard session not found",
              details: { code: "WIZARD_NOT_FOUND" },
            });
          }
          if (!session) {
            throw new Error("Expected admitted sign-in");
          }
          if (params?.answer) {
            await session.answer(params.answer.stepId, params.answer.value);
          }
          const result = await session.next();
          if (result.done) {
            purged = true;
            terminalRead.resolve();
            await terminalDelivery.promise;
          }
          return result;
        }
        if (method === "wizard.cancel") {
          session?.cancel();
          completed.resolve();
          manualAbort.abort();
          await session?.whenSettled();
          return { status: "cancelled" };
        }
        return originalRequest(method);
      },
    );
    const page = appendPage(context);
    try {
      await chooseLogin(page, "Example browser sign-in");
      await waitForSolid(() =>
        expect(page.querySelector<HTMLAnchorElement>(".wizard-sign-in a")?.href).toBe(
          "https://provider.example/sign-in",
        ),
      );
      expectContent(page.renderRoot, [], ["Scope:"]);
      expect(page.querySelector<HTMLDetailsElement>(".wizard-step__manual-entry")?.open).toBe(
        false,
      );
      completed.resolve();
      await vi.advanceTimersByTimeAsync(1000);
      await terminalRead.promise;
      await submitCredential(page);
      terminalDelivery.resolve();
      await waitForSolid(
        () => expect(page.renderRoot.textContent).toContain("Provider credentials saved."),
        { timeout: 3000 },
      );
      expectContent(page.querySelector(".model-setup-wizard"), [
        "Example browser sign-in is connected",
      ]);
      expect(session?.getStatus()).toBe("done");
      expectContent(page.renderRoot, ["Saved sign-in; configuration refresh failed."]);
      const reads = requestCount(request, "wizard.next");
      await vi.advanceTimersByTimeAsync(1100);
      expect(requestCount(request, "wizard.next")).toBe(reads);
    } finally {
      session?.cancel();
      completed.resolve();
      terminalDelivery.resolve();
      manualAbort.abort();
      await session?.whenSettled();
    }
  });

  it("keeps recovery guidance in the next input", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    const guidance =
      "Node/OpenSSL cannot validate TLS certificates. Run brew postinstall ca-certificates, then retry sign-in.";
    let shown = false;
    request.mockImplementation(async (method) => {
      if (method !== "wizard.next") {
        return originalRequest(method);
      }
      if (!shown) {
        shown = true;
        return {
          done: false,
          status: "running",
          step: { id: "provider-help", type: "note", executor: "client", message: guidance },
        };
      }
      return {
        done: false,
        status: "running",
        step: {
          id: "client-id",
          type: "text",
          executor: "client",
          message: "Enter the client ID",
        },
      };
    });
    const page = appendPage(context);
    await chooseLogin(page, "Example browser sign-in");
    await waitForText(page, "openclaw-modal-dialog", guidance);
    expectContent(page.querySelector("openclaw-modal-dialog"), ["Enter the client ID"]);
  });

  it("keeps the selected credential save and provider refresh when dismissal is refused", async () => {
    const { context, runtimeConfig, answer, cancel } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);

    const input = page.querySelector<HTMLInputElement>(
      'input[type="password"][name="wizard-text"]',
    )!;
    expect(input).not.toBeNull();
    await submitCredential(page);
    await waitForSolid(() => expect(input.disabled).toBe(true));
    expect(page.querySelector('input[name="wizard-text"]')).toBe(input);
    expect(input.value).toBe("synthetic-test-credential");
    expect(
      [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
        (button) => button.textContent?.trim() === "Cancel",
      )?.disabled,
    ).toBe(false);

    const dismissal = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
    page.querySelector("openclaw-modal-dialog")!.dispatchEvent(dismissal);
    expect(dismissal.defaultPrevented).toBe(true);
    cancel.resolve({ status: "running" });
    await waitForSolid(() => expectContent(page.renderRoot, ["Credentials are being saved."]));
    expectPresent(page, "openclaw-modal-dialog");
    expectDisabled(page, "[data-models-connect]", true);

    answer.resolve({ done: true, status: "done" });
    await waitForSolid(() => expectContent(page.renderRoot, ["Provider credentials saved."]));
    expectContent(page.renderRoot, [], ["cancelled"]);
    await waitForSolid(() => expectPresent(page, '[data-provider-id="example"]'));
    expectContent(page.querySelector(".model-setup-wizard"), ["Example API key is connected"]);
    expect(context.navigate).not.toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("releases a saved login on disposal while Cancel is pending and allows a second login", async () => {
    const { context, request, publishEvent } = loginHarness();
    const client = context.gateway.snapshot.client!;
    const initialAuth = await client.request<ModelAuthStatusResult>("models.authStatus");
    const originalRequest = request.getMockImplementation()!;
    const cancelled = deferred<{ status: "running" }>();
    const cancelReceived = deferred();
    const sessions = new Map<string, WizardSession>();
    const profiles = new Set<string>();
    request.mockImplementation(
      async (method, params?: Partial<WizardNextParams & WizardCancelParams>) => {
        if (method === "models.authStatus") {
          return {
            ...initialAuth,
            providers: profiles.size
              ? [
                  {
                    provider: "example",
                    displayName: "Example provider",
                    status: "ok",
                    profiles: [...profiles].map((profileId) =>
                      authProfile(profileId, { type: "api_key" }),
                    ),
                  },
                ]
              : [],
          };
        }
        if (!method.startsWith("wizard.") && method !== "models.authLogin") {
          return originalRequest(method);
        }
        if (!params?.sessionId) {
          throw new Error("Wizard request has no session ID");
        }
        if (method === "models.authLogin") {
          if ([...sessions.values()].some((session) => !session.isSettled())) {
            throw new Error("Another login is still running");
          }
          const profileId = `example:${sessions.size + 1}`;
          const session = new WizardSession(async (prompter, _signal, owner) => {
            await prompter.text({ message: "Enter your key", sensitive: true });
            owner.lockCancellation();
            profiles.add(profileId);
            publishEvent({ type: "event", event: "chat.metadata.changed", payload: {} });
            await prompter.note("Credentials saved. Continue to finish.", "Provider notes");
          });
          sessions.set(params.sessionId, session);
          return { sessionId: params.sessionId, done: false, status: "running" };
        }
        const session = sessions.get(params.sessionId);
        if (!session) {
          throw new Error("Unknown wizard session");
        }
        if (method === "wizard.next") {
          if (params.answer) {
            await session.answer(params.answer.stepId, params.answer.value);
          }
          return session.next();
        }
        if (method === "wizard.cancel") {
          if (!params.closeInput) {
            session.cancel();
            cancelReceived.resolve();
            return cancelled.promise;
          }
          session.close(new Error("Provider credentials were saved, but the view closed."));
          await session.whenSettled();
        }
        return { status: session.getStatus(), error: session.getError() };
      },
    );

    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);
    await waitForSolid(() =>
      expectContent(page.renderRoot, ["Credentials saved. Continue to finish."]),
    );
    click(page, ".wizard-step__actions .btn");
    await cancelReceived.promise;
    const first = [...sessions.values()][0]!;
    expect(first.isSettled()).toBe(false);

    unmountPage(page);
    await waitForSolid(() => expect(first.isSettled()).toBe(true));
    expect(first.getStatus()).toBe("error");
    expect(first.getError()).toContain("credentials were saved");
    expect(profiles.has("example:1")).toBe(true);
    const replacement = appendPage(context);
    await openLogin(replacement);
    expectPresent(replacement, '[data-provider-id="example"]');
    cancelled.resolve({ status: "running" });
    await replacement.updateComplete;
    expect(context.gateway.snapshot.client).toBe(client);
    expectContent(replacement.renderRoot, [], ["Provider credentials saved."]);
    expectDisabled(replacement, 'input[name="wizard-text"]', false);

    await submitCredential(replacement);
    await waitForSolid(() =>
      expectContent(replacement.renderRoot, ["Credentials saved. Continue to finish."]),
    );
    click(replacement, ".wizard-step__actions .btn.primary");
    await waitForSolid(() =>
      expectContent(replacement.renderRoot, ["Provider credentials saved."]),
    );
    expect(sessions.size).toBe(2);
    expect([...profiles]).toEqual(["example:1", "example:2"]);
  });

  it("keeps Connect disabled until cancellation is purged", async () => {
    const { context, request, cancel, status } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);
    click(page, ".wizard-step__actions .btn");
    cancel.resolve({ status: "cancelled" });
    await waitForSolid(() => expect(requestCount(request, "wizard.status")).toBeGreaterThan(0));
    expectPresent(page, "openclaw-modal-dialog");
    expectDisabled(page, "[data-models-connect]", true);

    status.reject(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Wizard session not found",
        details: { code: "WIZARD_NOT_FOUND" },
      }),
    );

    await waitForSolid(() => expectAbsent(page, "openclaw-modal-dialog"));
    expectDisabled(page, "[data-models-connect]", false);
    expectContent(page.renderRoot, [], ["Provider credentials saved."]);
    click(page, "[data-models-connect]");
    await page.updateComplete;
    expectPresent(page, "[data-models-login-search]");
  });

  it("does not publish a previous agent's completion after selection changes", async () => {
    const { context, settingsAgentSelection, notifySelection, answer, cancel } = loginHarness();
    const mutations = vi.spyOn(context.runtimeConfig, "runExternalMutation");
    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);
    settingsAgentSelection.state.selectedId = "main";
    settingsAgentSelection.state.scopeId = "main";
    notifySelection();
    await waitForSolid(() => expectAbsent(page, "openclaw-modal-dialog"));

    cancel.resolve({ status: "running" });
    answer.resolve({ done: true, status: "done" });
    await mutations.mock.results.at(-1)?.value;
    await page.updateComplete;
    expectContent(page.renderRoot, [], ["Provider credentials saved."]);
    expectAbsent(page, 'input[name="wizard-text"]');
  });

  it("groups and searches advertised providers before selecting their supported sign-in method", async () => {
    const base = loginHarness();
    const auth =
      await base.context.gateway.snapshot.client!.request<ModelAuthStatusResult>(
        "models.authStatus",
      );
    const example = auth.providerCapabilities![0]!;
    for (const [index, choice] of example.loginOptions!.entries()) {
      choice.featured = index !== 0;
    }
    const { context, request, runtimeConfig } = loginHarness({
      providers: [
        {
          provider: "example",
          displayName: "Example",
          status: "static",
          profiles: [],
          apiKey: { source: "env", envVar: "EXAMPLE_API_KEY" },
        },
      ],
      capabilities: [
        example,
        { ...example, provider: "example-alias" },
        authCapability("alpha", {
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            loginOption("plugin/alpha-key", "alpha", "Account key", "secret", {
              groupLabel: "Alpha",
            }),
          ],
        }),
        authCapability("quick-key-only", { apiKeySupported: true, quickApiKeySetup: true }),
        authCapability("unsupported", { apiKeySupported: true }),
      ],
    });
    const page = appendPage(context);
    await openPicker(page);
    expect(providerChoices(page)).toEqual(["alpha", "example", "quick-key-only"]);
    expectAbsent(page, "[data-models-login-choice]");
    expectPresent(page, "[data-models-login-discover]");
    expect(requestCount(request, "models.authLogin")).toBe(0);

    await searchProviders(page, "  EXAMPLE  ");
    expect(providerChoices(page)).toEqual(["example"]);
    await searchProviders(page, "browser sign-in");
    expect(providerChoices(page)).toEqual(["example"]);
    await searchProviders(page, "your Example account key");
    expect(providerChoices(page)).toEqual(["example"]);
    await selectProvider(page, "example");
    expect(
      [...page.querySelectorAll("[data-models-login-choice] strong")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Example browser sign-in", "Example API key"]);
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-choice] button"));
    expectAbsent(page, "[data-models-login-start]");
    expectAbsent(page, "[data-models-login-discover]");
    const dialog = page.querySelector("openclaw-modal-dialog")!;
    expectContent(dialog, [
      "Accounts available to this agent",
      "API key from environment (EXAMPLE_API_KEY)",
    ]);
    expectAbsent(dialog, 'input[type="password"]');
    expectPresent(dialog, 'a[href="https://docs.openclaw.ai/concepts/model-providers"]');

    click(page, "[data-models-login-back]");
    await page.updateComplete;
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-search]"));
    expect(page.querySelector<HTMLInputElement>("[data-models-login-search]")!.value).toBe(
      "your Example account key",
    );
    await searchProviders(page, "no such provider");
    expect(providerChoices(page)).toEqual([]);
    expectContent(page.querySelector(".model-provider-login [role=status]"), [
      "No providers match",
    ]);
    await searchProviders(page, "");
    expect(providerChoices(page)).toEqual(["alpha", "example", "quick-key-only"]);
    await selectProvider(page, "quick-key-only");
    expectAbsent(page, "[data-models-login-choice] button");
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-api-key]"));
    click(page, "[data-models-login-back]");
    await page.updateComplete;
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-search]"));
    await selectProvider(page, "example");
    click(page, "[data-models-login-api-key]");
    await page.updateComplete;
    expectAbsent(page, "[data-models-login-search]", "[data-models-login-choice]");
    expectPresent(page, 'openclaw-modal-dialog input[type="password"]');
    expect(page.view.props).toMatchObject({ addProviderId: "example", addProviderOpen: true });
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
  });

  it("shows accounts from the selected provider's credential owner before another login", async () => {
    const { context, request, answer } = loginHarness({
      capabilities: [
        authCapability("example-owner", {
          loginOptions: [
            loginOption("example-browser", "example", "Example browser sign-in", "oauth", {
              groupLabel: "Example provider",
              featured: true,
            }),
          ],
        }),
      ],
      providers: [
        {
          provider: "example-owner",
          authProvider: "example-owner",
          displayName: "Example provider",
          status: "ok",
          profiles: [
            authProfile("example:external", {
              source: "external",
              email: "same-account@example.invalid",
              displayName: "External CLI account",
            }),
          ],
        },
        {
          provider: "unrelated",
          displayName: "Unrelated provider",
          status: "ok",
          profiles: [authProfile("unrelated:one", { email: "other-provider@example.invalid" })],
        },
      ],
    });
    const page = appendPage(context);
    const card = await expandProvider(page, "example-owner");
    const addAccount = [...card.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add account",
    );
    expect(addAccount?.disabled).toBe(false);
    addAccount!.click();
    await page.updateComplete;
    expectAbsent(page, "[data-models-login-search]");
    expectContent(page.querySelector(".model-provider-login__provider"), ["Example provider"]);
    const dialog = page.querySelector("openclaw-modal-dialog")!;
    expectContent(dialog, ["Accounts available to this agent"]);
    const profiles = [...dialog.querySelectorAll<HTMLElement>("[data-profile-id]")];
    expect(profiles.map((profile) => profile.dataset.profileId)).toEqual(["example:external"]);
    expectContent(profiles[0], ["External CLI account", "same-account@example.invalid"]);
    expectContent(dialog, [], ["other-provider@example.invalid"]);
    const originalRequest = request.getMockImplementation()!;
    request.mockImplementation(async (method, ...args) => {
      if (method !== "models.authStatus") {
        return originalRequest(method, ...args);
      }
      return {
        ts: 2,
        providers: [
          {
            provider: "example-owner",
            displayName: "Example provider",
            status: "ok",
            profiles: [authProfile("example:new", { email: "new-account@example.invalid" })],
          },
        ],
      };
    });
    await startSelectedLogin(page, "Example browser sign-in");
    answer.resolve({ done: true, status: "done" });
    await submitCredential(page);
    await waitForSolid(() => expect(card.textContent).toContain("new-account@example.invalid"));
    expectContent(card, [], ["same-account@example.invalid"]);
  });

  it("reveals and focuses new inventory before a cancelled agent's read settles", async () => {
    const { context, request } = loginHarness();
    const originalRequest = request.getMockImplementation()!;
    const previousInventory = deferred<ModelAuthStatusResult>();
    let inventoryReads = 0;
    request.mockImplementation(async (method, ...args) => {
      if (method === "models.authStatus" && inventoryReads++ === 0) {
        return previousInventory.promise;
      }
      return originalRequest(method, ...args);
    });
    const scope = { agentId: "writer" };
    const view = mountLogin(context, scope);
    const { controller } = view;
    const openingPrevious = controller.open();
    expect(controller.busy).toBe(true);
    await waitForSolid(() =>
      expect(
        view.container.querySelector('.model-provider-login [role="status"]')?.textContent,
      ).toBe("Loading…"),
    );
    click(view.container, "openclaw-modal-actions .btn");
    expect(controller.busy).toBe(false);
    scope.agentId = "reviewer";
    await controller.open();
    await waitForSolid(() => {
      const input = view.container.querySelector("[data-models-login-search]");
      expect(input).not.toBeNull();
      expect(document.activeElement).toBe(input);
      expect(providerChoices(view.container)).toEqual(["example"]);
    });
    const input = view.container.querySelector("[data-models-login-search]");
    previousInventory.resolve({ ts: 1, providers: [], providerCapabilities: [] });
    await openingPrevious;
    await waitForSolid(() => {
      expect(view.container.querySelector("[data-models-login-search]")).toBe(input);
      expect(providerChoices(view.container)).toEqual(["example"]);
    });
    view.unmount();
  });

  it.each([false, true])("reopens after an inventory error (cached auth: %s)", async (cached) => {
    const { context, request } = loginHarness();
    const ready =
      await context.gateway.snapshot.client!.request<ModelAuthStatusResult>("models.authStatus");
    request.mockClear();
    request.mockRejectedValueOnce(new Error("Inventory unavailable"));
    const scope: { agentId: string; authStatus?: ModelAuthStatusResult } = { agentId: "writer" };
    const view = mountLogin(context, scope);
    const { controller } = view;
    await controller.open();
    await waitForText(view.container, '[role="alert"]', "Inventory unavailable");
    click(view.container, "openclaw-modal-actions .btn");
    if (cached) {
      scope.authStatus = ready;
    }
    await controller.open();
    await waitForSolid(() => {
      expectAbsent(view.container, '[role="alert"]');
      expect(providerChoices(view.container)).toEqual(["example"]);
    });
    expect(requestCount(request, "models.authStatus")).toBe(cached ? 1 : 2);
    view.unmount();
  });

  it.each([false, true])(
    "offers optional discovery without login choices (inventory unavailable: %s)",
    async (unavailable) => {
      const { context, request } = loginHarness({ capabilities: [] });
      if (unavailable) {
        request.mockRejectedValue(new Error("Account inventory unavailable"));
      }
      const onDiscover = vi.fn(() => expect(controller.busy).toBe(false));
      const view = mountLogin(context, undefined, onDiscover);
      const { controller, container } = view;
      expect(controller.pageActions.connectDisabled).toBe(false);
      await controller.pageActions.onConnect();
      await waitForSolid(() => expectPresent(container, "openclaw-modal-dialog"));
      const modal = container.querySelector("openclaw-modal-dialog")!;
      expect(modal.isConnected).toBe(true);
      expect(providerChoices(container)).toEqual([]);
      expect(controller.busy).toBe(true);
      click(container, "[data-models-login-discover]");
      expect(onDiscover).toHaveBeenCalledOnce();
      expect(controller.busy).toBe(false);
      expect(
        request.mock.calls.some(
          ([method]) => method === "models.authLogin" || method.startsWith("openclaw.setup."),
        ),
      ).toBe(false);
      view.unmount();
      expectAbsent(container, "[data-models-login-search]");
      // Discovery can replace the picker before its custom-element update finishes.
      await modal.updateComplete;
      expect(document.openClawModalLayers?.has(modal)).toBe(false);
    },
  );
});
