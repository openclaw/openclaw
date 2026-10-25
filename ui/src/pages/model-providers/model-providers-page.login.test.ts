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
  museCodeCapability,
  loginHarness,
  openPicker,
  selectProvider,
  chooseLogin,
  openLogin,
} from "./model-providers-page.login.test-support.ts";
import {
  appendPage,
  expandProvider,
  unmountPage,
  type ModelProvidersPageTestElement,
  startSelectedLogin,
  submitCredential,
} from "./model-providers-page.test-support.tsx";

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

describe("Models provider login", () => {
  it.each([
    { setup: false, entry: "provider-access" },
    { setup: false, entry: "readiness" },
    { setup: true, entry: "readiness" },
  ])("connects Muse Code (setup: $setup, entry: $entry)", async ({ setup, entry }) => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const { context, request, answer } = loginHarness({
      capabilities: [museCodeCapability()],
    });
    const originalRequest = request.getMockImplementation()!;
    const authStatusReady = deferred();
    request.mockImplementation(async (method, ...args) => {
      if (method === "models.authStatus" && setup) {
        await authStatusReady.promise;
      }
      return method === "models.list" && !setup
        ? {
            models: [{ provider: "openai", id: "working", name: "Working model", available: true }],
          }
        : originalRequest(method, ...args);
    });
    const page = appendPage(context);
    if (entry === "readiness") {
      // The setup prompt shows only until a model works; Provider access connects after that.
      const connect = setup ? "[data-model-readiness] button" : "[data-models-connect]";
      await waitForSolid(() => {
        expect(page.querySelector("[data-model-readiness]") !== null).toBe(setup);
        expect(page.querySelector<HTMLButtonElement>(connect)?.disabled).toBe(false);
      });
      if (setup) {
        expect(page.view.props.loading).toBe(true);
      }
      page.querySelector<HTMLButtonElement>(connect)!.click();
      await page.updateComplete;
    } else {
      await openPicker(page);
    }
    if (setup) {
      await waitForSolid(() =>
        expect(page.querySelector('.model-provider-login [role="status"]')).not.toBeNull(),
      );
      authStatusReady.resolve();
    }
    await selectProvider(page, "meta");
    if (!setup) {
      expect(page.renderRoot.textContent).toContain(
        "Sign in and enable this provider for this agent without changing the active model.",
      );
    }
    await startSelectedLogin(page, "Muse Code");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        sessionId: expect.any(String),
        authChoice: "meta/muse-code",
        agentId: "writer",
        ...(setup ? { selectModel: true } : {}),
      },
      { timeoutMs: null },
    );
    const authReads = request.mock.calls.filter(([name]) => name === "models.authStatus").length;
    answer.resolve({
      done: true,
      status: "done",
      modelActivation: { modelRef: "meta/muse-spark-1.3" },
    });
    await submitCredential(page);
    await waitForSolid(() =>
      expect(page.renderRoot.textContent).toContain(
        setup
          ? "Account verified and selected for this agent's default model."
          : "Muse Code: Provider enabled. The active model has not changed.",
      ),
    );
    if (!setup) {
      expect(page.renderRoot.textContent).not.toContain("selected for this agent");
    }
    await waitForSolid(() =>
      expect(
        request.mock.calls.filter(([name]) => name === "models.authStatus").length,
      ).toBeGreaterThan(authReads),
    );
  });

  it.each([
    { kind: "oauth", cancel: false, submit: false },
    { kind: "oauth", cancel: false, submit: true },
    { kind: "device-code", cancel: true, submit: false },
  ] as const)(
    "settles $kind sign-in through the registered Models page without a Continue (cancel: $cancel, submit: $submit)",
    async ({ kind, cancel, submit }) => {
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
              } else {
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
        await chooseLogin(page, "Example browser sign-in");
        await waitForSolid(() =>
          expect(page.querySelector<HTMLAnchorElement>(".wizard-sign-in a")?.href).toBe(
            "https://provider.example/sign-in",
          ),
        );
        expect(page.renderRoot.textContent).not.toContain("Scope:");
        expect(
          [...page.querySelectorAll("openclaw-modal-dialog button")].some(
            (button) => button.textContent?.trim() === "Continue",
          ),
        ).toBe(false);
        if (kind === "device-code") {
          expect(page.querySelector(".wizard-step__sign-in-code")?.textContent).toBe("PAIR-1234");
        } else {
          expect(page.querySelector<HTMLDetailsElement>(".wizard-step__manual-entry")?.open).toBe(
            false,
          );
        }
        if (cancel) {
          page
            .querySelector<HTMLButtonElement>(
              'openclaw-modal-dialog button[aria-label="Cancel sign-in"]',
            )!
            .click();
          await waitForSolid(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
          expect(session?.getStatus()).toBe("cancelled");
        } else {
          completed.resolve();
          await vi.advanceTimersByTimeAsync(1000);
          if (submit) {
            await terminalRead.promise;
            await submitCredential(page);
            terminalDelivery.resolve();
          }
          await waitForSolid(
            () => expect(page.renderRoot.textContent).toContain("Provider credentials saved."),
            { timeout: 3000 },
          );
          expect(page.querySelector(".model-setup-wizard")?.textContent).toContain(
            "Example browser sign-in is connected",
          );
          expect(session?.getStatus()).toBe("done");
          expect(page.renderRoot.textContent).toContain(
            "Saved sign-in; configuration refresh failed.",
          );
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
    "keeps recovery guidance in the next %s and exposes terminal errors directly",
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
      await chooseLogin(page, "Example browser sign-in");
      await waitForSolid(() =>
        expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
          outcome === "error" ? "Certificate validation failed." : guidance,
        ),
      );
      if (outcome === "error") {
        const alert = page.querySelector<HTMLElement>("[role=alert]")!;
        expect(alert.querySelector(".model-setup-wizard__error-text")?.textContent).toBe(
          ["Certificate validation failed.", guidance].join("\n\n"),
        );
        expect(alert.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')).not.toBeNull();
        expect(page.querySelector("openclaw-modal-dialog details")).toBeNull();
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

  it("keeps the selected credential save and provider refresh when dismissal is refused", async () => {
    const { context, request, runtimeConfig, answer, cancel } = loginHarness();
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
    await waitForSolid(() =>
      expect(page.renderRoot.textContent).toContain("Credentials are being saved."),
    );
    expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

    answer.resolve({ done: true, status: "done" });
    await waitForSolid(() =>
      expect(page.renderRoot.textContent).toContain("Provider credentials saved."),
    );
    expect(page.renderRoot.textContent).not.toContain("cancelled");
    await waitForSolid(() =>
      expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
    );
    expect(page.querySelector(".model-setup-wizard")?.textContent).toContain(
      "Example API key is connected",
    );
    expect(context.navigate).not.toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(false);
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
    await waitForSolid(() =>
      expect(page.renderRoot.textContent).toContain("Credentials saved. Continue to finish."),
    );
    page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn")!.click();
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
    expect(replacement.querySelector('[data-provider-id="example"]')).not.toBeNull();
    cancelled.resolve({ status: "running" });
    await replacement.updateComplete;
    expect(context.gateway.snapshot.client).toBe(client);
    expect(replacement.renderRoot.textContent).not.toContain("Provider credentials saved.");
    expect(replacement.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(
      false,
    );

    await submitCredential(replacement);
    await waitForSolid(() =>
      expect(replacement.renderRoot.textContent).toContain(
        "Credentials saved. Continue to finish.",
      ),
    );
    replacement.querySelector<HTMLButtonElement>(".wizard-step__actions .btn.primary")!.click();
    await waitForSolid(() =>
      expect(replacement.renderRoot.textContent).toContain("Provider credentials saved."),
    );
    expect(sessions.size).toBe(2);
    expect([...profiles]).toEqual(["example:1", "example:2"]);
  });

  it("keeps Connect disabled until cancellation is purged", async () => {
    const { context, request, cancel, status } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);
    page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn")!.click();
    cancel.resolve({ status: "cancelled" });
    await waitForSolid(() =>
      expect(request.mock.calls.some(([method]) => method === "wizard.status")).toBe(true),
    );
    expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

    status.reject(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Wizard session not found",
        details: { code: "WIZARD_NOT_FOUND" },
      }),
    );

    await waitForSolid(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false);
    expect(page.renderRoot.textContent).not.toContain("Provider credentials saved.");
    page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
    await page.updateComplete;
    expect(page.querySelector("[data-models-login-search]")).not.toBeNull();
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
    await waitForSolid(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());

    cancel.resolve({ status: "running" });
    answer.resolve({ done: true, status: "done" });
    await mutations.mock.results.at(-1)?.value;
    await page.updateComplete;
    expect(page.renderRoot.textContent).not.toContain("Provider credentials saved.");
    expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')).toBeNull();
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
    const { context, request } = loginHarness({
      capabilities: [
        {
          provider: "zebra",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "plugin/zebra-login",
              brandId: "zebra",
              groupLabel: "Zebra",
              label: "Device sign-in",
              kind: "device-code",
              featured: true,
            },
          ],
        },
        example,
        { ...example, provider: "example-alias" },
        {
          provider: "alpha",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            {
              id: "plugin/alpha-key",
              brandId: "alpha",
              groupLabel: "Alpha",
              label: "Account key",
              kind: "secret",
              featured: false,
            },
          ],
        },
        { provider: "quick-key-only", apiKeySupported: true, quickApiKeySetup: true },
        { provider: "unsupported", apiKeySupported: false, quickApiKeySetup: false },
      ],
    });
    const page = appendPage(context);
    await openPicker(page);
    expect(providerChoices(page)).toEqual(["alpha", "example", "quick-key-only", "zebra"]);
    expect(page.querySelector("[data-models-login-choice]")).toBeNull();
    expect(page.querySelector("[data-models-login-discover]")).not.toBeNull();
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);

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
    expect(page.querySelector("[data-models-login-start]")).toBeNull();
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    expect(page.querySelector("[data-models-login-discover]")).toBeNull();

    page.querySelector<HTMLButtonElement>("[data-models-login-back]")!.click();
    await page.updateComplete;
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-search]"));
    expect(page.querySelector<HTMLInputElement>("[data-models-login-search]")!.value).toBe(
      "your Example account key",
    );
    await searchProviders(page, "no such provider");
    expect(providerChoices(page)).toEqual([]);
    expect(page.querySelector(".model-provider-login [role=status]")?.textContent).toContain(
      "No providers match",
    );
    await searchProviders(page, "");
    expect(providerChoices(page)).toEqual(["alpha", "example", "quick-key-only", "zebra"]);
    await selectProvider(page, "quick-key-only");
    expect(page.querySelector("[data-models-login-choice] button")).toBeNull();
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-api-key]"));
    page.querySelector<HTMLButtonElement>("[data-models-login-back]")!.click();
    await page.updateComplete;
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-search]"));
    await selectProvider(page, "zebra");
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-choice] button"));
    await startSelectedLogin(page, "Device sign-in");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "plugin/zebra-login",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
  });

  it("shows accounts from the selected provider's credential owner before another login", async () => {
    const { context, request, answer } = loginHarness({
      capabilities: [
        {
          provider: "example-owner",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "example-browser",
              brandId: "example",
              groupLabel: "Example provider",
              label: "Example browser sign-in",
              kind: "oauth",
              featured: true,
            },
          ],
        },
      ],
      providers: [
        {
          provider: "example-owner",
          authProvider: "example-owner",
          displayName: "Example provider",
          status: "ok",
          profiles: [
            {
              profileId: "example:external",
              type: "oauth",
              status: "ok",
              source: "external",
              email: "same-account@example.invalid",
              displayName: "External CLI account",
            },
            {
              profileId: "example:saved",
              type: "oauth",
              status: "expiring",
              source: "saved",
              email: "same-account@example.invalid",
              displayName: "Saved browser account",
            },
          ],
        },
        {
          provider: "unrelated",
          displayName: "Unrelated provider",
          status: "ok",
          profiles: [
            {
              profileId: "unrelated:one",
              type: "oauth",
              status: "ok",
              email: "other-provider@example.invalid",
            },
          ],
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
    expect(page.querySelector("[data-models-login-search]")).toBeNull();
    expect(page.querySelector(".model-provider-login__provider")?.textContent).toContain(
      "Example provider",
    );
    const dialog = page.querySelector("openclaw-modal-dialog")!;
    expect(dialog.textContent).toContain("Accounts available to this agent");
    const profiles = [...dialog.querySelectorAll<HTMLElement>("[data-profile-id]")];
    expect(profiles.map((profile) => profile.dataset.profileId)).toEqual([
      "example:external",
      "example:saved",
    ]);
    expect(
      profiles.every((profile) => profile.textContent?.includes("same-account@example.invalid")),
    ).toBe(true);
    expect(profiles[0]?.textContent).toContain("External CLI account");
    expect(profiles[1]?.textContent).toContain("Saved browser account");
    expect(profiles[1]?.textContent).toContain("Expiring");
    expect(dialog.textContent).not.toContain("other-provider@example.invalid");
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
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
            profiles: [
              {
                profileId: "example:new",
                type: "oauth",
                status: "ok",
                email: "new-account@example.invalid",
              },
            ],
          },
        ],
      };
    });
    await startSelectedLogin(page, "Example browser sign-in");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "example-browser",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
    answer.resolve({ done: true, status: "done" });
    await submitCredential(page);
    await waitForSolid(() => expect(card.textContent).toContain("new-account@example.invalid"));
    expect(card.textContent).not.toContain("same-account@example.invalid");
  });

  it("preserves quick API-key setup alongside browser login", async () => {
    const { context, request, runtimeConfig } = loginHarness({
      providers: [
        {
          provider: "quick-key",
          displayName: "Quick key",
          status: "static",
          profiles: [],
          apiKey: { source: "env", envVar: "QUICK_KEY_API_KEY" },
        },
      ],
      capabilities: [
        {
          provider: "quick-key",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            {
              id: "fixture/browser",
              brandId: "quick-key",
              label: "Browser sign-in",
              kind: "oauth",
              featured: true,
            },
          ],
        },
        { provider: "unsupported", apiKeySupported: true, quickApiKeySetup: false },
      ],
    });
    const page = appendPage(context);
    await openPicker(page);
    expect(providerChoices(page)).toEqual(["quick-key"]);
    await selectProvider(page, "quick-key");

    expect(
      [...page.querySelectorAll("[data-models-login-choice] strong")].map(
        (option) => option.textContent,
      ),
    ).toEqual(["Browser sign-in"]);

    const dialog = page.querySelector("openclaw-modal-dialog")!;
    expect(dialog.textContent).toContain("Accounts available to this agent");
    expect(dialog.textContent).toContain("API key from environment (QUICK_KEY_API_KEY)");
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
    expect(page.view.props.addProviderId).toBe("quick-key");
    expect(page.view.props.addProviderOpen).toBe(true);
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(false);
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
    let agentId = "writer";
    let controller!: ModelProviderLogin;
    const view = mountSolid(() => {
      controller = createModelProviderLogin({
        getScope: () => ({ context, agentId, connectionEpoch: 1 }),
        canStart: () => true,
        canContinue: () => true,
        refresh: async () => undefined,
      });
      return createComponent(ModelProviderLoginView, { controller });
    });
    const openingPrevious = controller.open();
    expect(controller.busy).toBe(true);
    await waitForSolid(() =>
      expect(
        view.container.querySelector('.model-provider-login [role="status"]')?.textContent,
      ).toBe("Loading…"),
    );
    view.container.querySelector<HTMLButtonElement>("openclaw-modal-actions .btn")!.click();
    expect(controller.busy).toBe(false);
    agentId = "reviewer";
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
    let authStatus: ModelAuthStatusResult | undefined;
    let controller!: ModelProviderLogin;
    const view = mountSolid(() => {
      controller = createModelProviderLogin({
        getScope: () => ({ context, agentId: "writer", connectionEpoch: 1, authStatus }),
        canStart: () => true,
        canContinue: () => true,
        refresh: async () => undefined,
      });
      return createComponent(ModelProviderLoginView, { controller });
    });
    await controller.open();
    await waitForSolid(() =>
      expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Inventory unavailable",
      ),
    );
    view.container.querySelector<HTMLButtonElement>("openclaw-modal-actions .btn")!.click();
    if (cached) {
      authStatus = ready;
    }
    await controller.open();
    await waitForSolid(() => {
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      expect(providerChoices(view.container)).toEqual(["example"]);
    });
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
      cached ? 1 : 2,
    );
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
      let controller!: ModelProviderLogin;
      const container = document.createElement("div");
      document.body.append(container);
      const view = mountSolid(
        () => {
          controller = createModelProviderLogin({
            getScope: () => ({ context, agentId: "writer", connectionEpoch: 1 }),
            canStart: () => true,
            canContinue: () => true,
            refresh: async () => undefined,
            onDiscover,
          });
          return createComponent(ModelProviderLoginView, { controller });
        },
        { container },
      );
      expect(controller.pageActions.connectDisabled).toBe(false);
      await controller.pageActions.onConnect();
      await waitForSolid(() =>
        expect(container.querySelector("openclaw-modal-dialog")).not.toBeNull(),
      );
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
      view.unmount();
      expect(container.querySelector("[data-models-login-search]")).toBeNull();
      // Discovery can replace the picker before its custom-element update finishes.
      await modal.updateComplete;
      expect(document.openClawModalLayers?.has(modal)).toBe(false);
    },
  );
});
