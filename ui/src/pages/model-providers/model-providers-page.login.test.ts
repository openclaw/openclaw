/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WizardCancelParams,
  WizardNextParams,
} from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import {
  loginHarness,
  openPicker,
  providerChoices,
  selectProvider,
} from "../../test-helpers/model-provider-login.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import {
  appendPage,
  clickLoginChoice,
  createHarness,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
  submitCredential,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function chooseLogin(page: ModelProvidersPageTestElement, choice = "example-secret") {
  await openPicker(page);
  await selectProvider(page, "example");
  clickLoginChoice(page, choice);
}

async function openLogin(page: ModelProvidersPageTestElement, choice = "example-secret") {
  await openPicker(page);
  await selectProvider(page, "example");
  await startSelectedLogin(page, choice);
}

describe("Models provider login", () => {
  it("shows the provider's first login method first and focuses it", async () => {
    const { context } = loginHarness({
      capabilities: [
        {
          provider: "openai",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "openai/siwc",
              brandId: "openai",
              label: "Sign in with ChatGPT",
              kind: "oauth",
              featured: false,
            },
            {
              id: "openai/device-code",
              brandId: "openai",
              label: "Codex login (device code)",
              kind: "device-code",
              featured: true,
            },
          ],
        },
      ],
    });
    const page = appendPage(context);
    await openPicker(page);
    await selectProvider(page, "openai");
    const options = [...page.querySelectorAll("[data-models-login-choice] button")];
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "Sign in with ChatGPT",
      "Codex login (device code)",
    ]);
    expect(document.activeElement).toBe(options[0]);
  });

  it.each([
    { kind: "oauth", cancel: false, submit: false, callbackOnly: false },
    { kind: "oauth", cancel: false, submit: false, callbackOnly: true },
    { kind: "oauth", cancel: true, submit: false, callbackOnly: true },
    { kind: "oauth", cancel: false, submit: true, callbackOnly: false },
    { kind: "device-code", cancel: false, submit: false, callbackOnly: false },
    { kind: "oauth", cancel: true, submit: false, callbackOnly: false },
    { kind: "device-code", cancel: true, submit: false, callbackOnly: false },
  ] as const)(
    "settles $kind sign-in through the registered Models page without a Continue (cancel: $cancel, submit: $submit, callback only: $callbackOnly)",
    async ({ kind, cancel, submit, callbackOnly }) => {
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
      const authStatus =
        await context.gateway.snapshot.client!.request<ModelAuthStatusResult>("models.authStatus");
      for (const capability of authStatus.providerCapabilities ?? []) {
        const option = capability.loginOptions?.find((choice) => choice.id === "example-browser");
        if (option) {
          option.kind = kind;
        }
      }
      const completed = deferred();
      const manualAbort = new AbortController();
      let session: WizardSession | undefined;
      let purged = false;
      const terminalRead = deferred();
      const terminalDelivery = deferred();
      const cancellationRead = deferred();
      request.mockImplementation(
        async (method, params?: Partial<WizardNextParams & WizardCancelParams>) => {
          if (method === "models.authStatus") {
            return authStatus;
          }
          if (method === "models.authLogin") {
            session = new WizardSession(async (prompter) => {
              await prompter.note("Scope: System / agent", "Provider sign-in");
              await prompter.openUrl?.("https://provider.example/sign-in");
              await prompter.note("Open the sign-in page.", "Provider instructions");
              if (kind === "device-code") {
                await prompter.deviceCode?.({
                  title: "Pair account",
                  code: "PAIR-1234",
                  message: "Enter this code to pair your account.",
                });
              } else if (!callbackOnly) {
                void prompter
                  .text({ message: "Paste the redirect URL", signal: manualAbort.signal })
                  .catch(() => {});
              }
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
            if (result.done && cancel && kind === "device-code") {
              await cancellationRead.promise;
            }
            if (result.done && submit) {
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
          if (method === "wizard.status") {
            cancellationRead.resolve();
            return { status: session?.getStatus() };
          }
          return originalRequest(method);
        },
      );
      const page = appendPage(context);
      try {
        await chooseLogin(page, "example-browser");
        await waitForFast(() =>
          expect(page.querySelector<HTMLAnchorElement>(".wizard-step__sign-in a")?.href).toBe(
            "https://provider.example/sign-in",
          ),
        );
        expect(page.textContent).not.toContain("Scope:");
        expect(
          [...page.querySelectorAll("openclaw-modal-dialog button")].some(
            (button) => button.textContent?.trim() === "Continue",
          ),
        ).toBe(false);
        if (kind === "device-code") {
          expect(page.querySelector(".wizard-step__sign-in-code")?.textContent).toBe("PAIR-1234");
        } else if (callbackOnly) {
          expect(page.querySelector(".wizard-step__manual-entry")).toBeNull();
          expect(page.querySelector('input[name="wizard-text"]')).toBeNull();
          expect(page.textContent).toContain("Waiting for sign-in");
          expect(page.textContent).not.toContain("Starting provider sign-in");
          const copy = [
            ...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button"),
          ].find((button) => button.textContent?.trim() === "Copy link");
          expect(copy?.disabled).toBe(false);
          expect(window.open).toHaveBeenCalled();
        } else {
          expect(page.querySelector<HTMLDetailsElement>(".wizard-step__manual-entry")?.open).toBe(
            false,
          );
        }
        if (cancel) {
          [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
            .find((button) => button.textContent?.trim() === "Cancel")!
            .click();
          await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
          expect(session?.getStatus()).toBe("cancelled");
        } else {
          completed.resolve();
          await vi.advanceTimersByTimeAsync(1000);
          if (submit) {
            await terminalRead.promise;
            await submitCredential(page);
            terminalDelivery.resolve();
          }
          await waitForFast(
            () => expect(page.textContent).toContain("Provider credentials saved."),
            { timeout: 3000 },
          );
          expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
          expect(session?.getStatus()).toBe("done");
          expect(page.textContent).toContain("Saved sign-in; configuration refresh failed.");
        }
        const reads = request.mock.calls.filter(([method]) => method === "wizard.next").length;
        await vi.advanceTimersByTimeAsync(1100);
        expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(
          reads,
        );
      } finally {
        session?.cancel();
        completed.resolve();
        terminalDelivery.resolve();
        cancellationRead.resolve();
        manualAbort.abort();
        await session?.whenSettled();
      }
    },
  );

  it.each(["error", "input"] as const)(
    "keeps recovery guidance in the next %s without replaying it in the ordinary alert",
    async (outcome) => {
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
        return outcome === "error"
          ? { done: true, status: "error", error: "Certificate validation failed." }
          : {
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
      await chooseLogin(page, "example-browser");
      await waitForFast(() =>
        expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
          outcome === "error" ? "Could not finish. Open Details" : guidance,
        ),
      );
      if (outcome === "error") {
        expect(page.querySelector("[role=alert]")?.textContent).not.toContain(guidance);
        const details = page.querySelector<HTMLDetailsElement>("openclaw-modal-dialog details")!;
        expect(details.open).toBe(false);
        details.querySelector("summary")!.click();
        expect(details.open).toBe(true);
        expect(details.querySelector("p")?.textContent).toBe(
          ["Certificate validation failed.", guidance].join("\n\n"),
        );
      }
      expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
        outcome === "error" ? "Certificate validation failed." : "Enter the client ID",
      );
      expect(request).toHaveBeenCalledWith(
        "wizard.next",
        { sessionId: expect.any(String), answer: { stepId: "provider-help" } },
        expect.anything(),
      );
    },
  );

  it("saves credentials through the selected manifest choice and refreshes the provider card", async () => {
    const { context, request, runtimeConfig, answer } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);

    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "example-secret",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
    expect(page.querySelector('input[type="password"][name="wizard-text"]')).not.toBeNull();
    await submitCredential(page);
    answer.resolve({ done: true, status: "done" });

    await waitForFast(() => expect(page.textContent).toContain("Provider credentials saved."));
    await waitForFast(() =>
      expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
    );
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(context.navigate).not.toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(false);
  });

  it("keeps the dialog and saved result when dismissal is refused during persistence", async () => {
    const { context, answer, cancel } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);

    const dismissal = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
    page.querySelector("openclaw-modal-dialog")!.dispatchEvent(dismissal);
    expect(dismissal.defaultPrevented).toBe(true);
    cancel.resolve({ status: "running" });
    await waitForFast(() => expect(page.textContent).toContain("Credentials are being saved."));
    expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

    answer.resolve({ done: true, status: "done" });
    await waitForFast(() => expect(page.textContent).toContain("Provider credentials saved."));
    expect(page.textContent).not.toContain("cancelled");
    await waitForFast(() =>
      expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
    );
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
                    profiles: [...profiles].map((profileId) => ({
                      profileId,
                      type: "api_key",
                      status: "ok",
                    })),
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
    await waitForFast(() =>
      expect(page.textContent).toContain("Credentials saved. Continue to finish."),
    );
    page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn")!.click();
    await cancelReceived.promise;
    const first = [...sessions.values()][0]!;
    expect(first.isSettled()).toBe(false);

    page.remove();
    await waitForFast(() => expect(first.isSettled()).toBe(true));
    expect(first.getStatus()).toBe("error");
    expect(first.getError()).toContain("credentials were saved");
    expect(profiles.has("example:1")).toBe(true);
    const replacement = appendPage(context);
    await openLogin(replacement);
    expect(replacement.querySelector('[data-provider-id="example"]')).not.toBeNull();
    cancelled.resolve({ status: "running" });
    await replacement.updateComplete;
    expect(context.gateway.snapshot.client).toBe(client);
    expect(replacement.textContent).not.toContain("Provider credentials saved.");
    expect(replacement.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(
      false,
    );

    await submitCredential(replacement);
    await waitForFast(() =>
      expect(replacement.textContent).toContain("Credentials saved. Continue to finish."),
    );
    replacement.querySelector<HTMLButtonElement>(".wizard-step__actions .btn.primary")!.click();
    await waitForFast(() =>
      expect(replacement.textContent).toContain("Provider credentials saved."),
    );
    expect(sessions.size).toBe(2);
    expect([...profiles]).toEqual(["example:1", "example:2"]);
  });

  it.each(["settled", "purged"])(
    "keeps Connect disabled until cancellation is %s",
    async (outcome) => {
      const { context, request, cancel, status } = loginHarness();
      const page = appendPage(context);
      await openLogin(page);
      page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn")!.click();
      cancel.resolve({ status: "cancelled" });
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "wizard.status")).toBe(true),
      );
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);
      if (outcome === "purged") {
        status.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Wizard session not found",
            details: { code: "WIZARD_NOT_FOUND" },
          }),
        );
      } else {
        status.resolve({ status: "cancelled" });
      }

      await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false);
      expect(page.textContent).not.toContain("Provider credentials saved.");
      page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
      await page.updateComplete;
      expect(page.querySelector("[data-models-login-search]")).not.toBeNull();
    },
  );

  it("does not publish a previous agent's completion after selection changes", async () => {
    const { context, settingsAgentSelection, notifySelection, answer, cancel } = loginHarness();
    const mutations = vi.spyOn(context.runtimeConfig, "runExternalMutation");
    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);
    settingsAgentSelection.state.selectedId = "main";
    settingsAgentSelection.state.scopeId = "main";
    notifySelection();
    await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());

    cancel.resolve({ status: "running" });
    answer.resolve({ done: true, status: "done" });
    await mutations.mock.results.at(-1)?.value;
    await page.updateComplete;
    expect(page.textContent).not.toContain("Provider credentials saved.");
    expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')).toBeNull();
  });

  it.each([false, true])(
    "preserves quick API-key setup alongside browser login: %s",
    async (withBrowser) => {
      const { context, request, runtimeConfig } = loginHarness({
        providers: [
          {
            provider: "quick-key",
            displayName: "Quick key",
            status: "static",
            profiles: [],
            apiKey: withBrowser
              ? { source: "env", envVar: "QUICK_KEY_API_KEY" }
              : { source: "config" },
          },
        ],
        capabilities: [
          {
            provider: "quick-key",
            apiKeySupported: true,
            quickApiKeySetup: true,
            loginOptions: withBrowser
              ? [
                  {
                    id: "fixture/browser",
                    brandId: "quick-key",
                    label: "Browser sign-in",
                    kind: "oauth",
                    featured: true,
                  },
                ]
              : [],
          },
          { provider: "unsupported", apiKeySupported: true, quickApiKeySetup: false },
        ],
      });
      const page = appendPage(context);
      await openPicker(page);
      expect(providerChoices(page)).toEqual(["quick-key"]);
      await selectProvider(page, "quick-key");
      if (withBrowser) {
        expect(
          [...page.querySelectorAll("[data-models-login-choice] strong")].map(
            (option) => option.textContent,
          ),
        ).toEqual(["Browser sign-in"]);
      }
      const dialog = page.querySelector("openclaw-modal-dialog")!;
      expect(dialog.textContent).toContain("Accounts available to this agent");
      expect(dialog.textContent).toContain(
        withBrowser ? "API key from environment (QUICK_KEY_API_KEY)" : "API key set in config",
      );
      expect(dialog.querySelector('input[type="password"]')).toBeNull();
      expect(
        dialog.querySelector('a[href="https://docs.openclaw.ai/concepts/model-providers"]'),
      ).not.toBeNull();
      expect(request.mock.calls.some(([method]) => method === "models.authSetApiKey")).toBe(false);
      const apiKey = page.querySelector<HTMLButtonElement>("[data-models-login-api-key]");
      expect(apiKey).not.toBeNull();
      apiKey!.click();
      await page.updateComplete;
      expect(page.querySelector("[data-models-login-search]")).toBeNull();
      expect(page.querySelector("[data-models-login-choice]")).toBeNull();
      expect(page.querySelector('openclaw-modal-dialog input[type="password"]')).not.toBeNull();
      expect(page.addProviderId).toBe("quick-key");
      expect(page.addProviderOpen).toBe(true);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
      expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(
        false,
      );
    },
  );

  it.each([false, true])(
    "offers optional discovery without login choices (inventory unavailable: %s)",
    async (unavailable) => {
      const { context, request } = loginHarness({ capabilities: [] });
      if (unavailable) {
        request.mockRejectedValue(new Error("Account inventory unavailable"));
      }
      const onDiscover = vi.fn(() => expect(controller.busy).toBe(false));
      const controller = new ModelProviderLoginController(
        {
          addController: vi.fn(),
          removeController: vi.fn(),
          requestUpdate: vi.fn(),
          updateComplete: Promise.resolve(true),
        },
        {
          getScope: () => ({ context, agentId: "writer" }),
          canStart: () => true,
          canContinue: () => true,
          refresh: async () => undefined,
          onDiscover,
        },
      );
      const container = document.createElement("div");
      document.body.append(container);
      expect(controller.pageActions.connectDisabled).toBe(false);
      await controller.pageActions.onConnect();
      render(controller.render(), container);
      const modal = container.querySelector("openclaw-modal-dialog")!;
      expect(modal.isConnected).toBe(true);
      expect(providerChoices(container)).toEqual([]);
      expect(controller.busy).toBe(true);
      container.querySelector<HTMLButtonElement>("[data-models-login-discover]")!.click();
      expect(onDiscover).toHaveBeenCalledOnce();
      expect(controller.busy).toBe(false);
      expect(
        request.mock.calls.some(
          ([method]) => method === "models.authLogin" || method.startsWith("openclaw.setup."),
        ),
      ).toBe(false);
      render(controller.render(), container);
      expect(container.querySelector("[data-models-login-search]")).toBeNull();
      // Discovery can replace the picker before its first Lit update finishes.
      await modal.updateComplete;
      expect(document.openClawModalLayers?.has(modal)).toBe(false);
    },
  );
});

it("keeps provider access scoped below global defaults and connects without navigation", async () => {
  const { context } = createHarness("writer");
  const page = appendPage(context);
  await waitForFast(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false),
  );
  const defaults = page.querySelector("#settings-model-behavior")!;
  const agent = page.querySelector("[data-models-provider-agent]")!;
  expect(page.querySelector("openclaw-agent-select")).toBeNull();
  expect(agent.textContent?.toLowerCase()).toContain("writer");
  expect(context.agentSelection.state.selectedId).toBe("main");
  expect(context.settingsAgentSelection.state.selectedId).toBe("writer");
  expect(defaults.contains(agent)).toBe(false);
  expect(defaults.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(agent.closest(".settings-section")?.textContent).toContain("Provider access");
  expect(
    [...page.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Model setup",
    ),
  ).toBe(false);
  page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
  await page.updateComplete;
  expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
  expect(context.navigate).not.toHaveBeenCalled();
  expect(defaults.isConnected).toBe(true);
});
