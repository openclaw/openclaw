/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { listSetupInferenceAuthOptions } from "../../../../src/system-agent/setup-inference-auth-options.js";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, detection, mountPage } from "./test-helpers/page.test-support.ts";

const authStatus: ModelAuthStatusResult = {
  ts: 1,
  providers: [],
  providerCapabilities: [
    {
      provider: "radius",
      apiKeySupported: false,
      quickApiKeySetup: false,
      loginOptions: [
        {
          id: "radius/radius",
          brandId: "radius",
          label: "Radius account",
          kind: "oauth",
          featured: true,
        },
      ],
    },
  ],
};

const setup = {
  ...detection,
  authOptions: listSetupInferenceAuthOptions([
    {
      pluginId: "setup-only",
      providerId: "setup-only",
      methodId: "oauth",
      choiceId: "setup-only",
      choiceLabel: "Setup-only account",
      appGuidedAuth: "oauth",
      onboardingFeatured: true,
    },
  ]),
};
const configSnapshot = {
  config: {},
  sourceConfig: {},
  raw: "{}",
  hash: "unchanged",
  valid: true,
  issues: [],
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["connect", "setup"] as const)(
  "Model Setup completes %s OAuth from a browser callback without manual submission",
  async (operation) => {
    const { context, client, request, runtimeConfig } = createContext();
    vi.spyOn(window, "open").mockReturnValue(null);
    const callback = createDeferred();
    const manual = new AbortController();
    let session: WizardSession | undefined;
    let verificationRuns = 0;
    request.mockImplementation(async (method, params) => {
      if (method === "models.authStatus") {
        return authStatus;
      }
      if (method === "config.get") {
        return configSnapshot;
      }
      if (method === "openclaw.setup.detect") {
        return setup;
      }
      if (method === "models.authLogin" || method === "openclaw.setup.auth.start") {
        expect(method).toBe(
          operation === "connect" ? "models.authLogin" : "openclaw.setup.auth.start",
        );
        session = new WizardSession(async (prompter, _signal, active) => {
          await prompter.note("Approve this account in your browser.", "Account access");
          await prompter.openUrl?.("https://example.invalid/authorize");
          void prompter
            .text({ message: "Paste the redirect URL", signal: manual.signal })
            .catch(() => {});
          await callback.promise;
          manual.abort();
          if (operation === "setup") {
            verificationRuns += 1;
            active.setModelActivation({ modelRef: "fixture/verified" });
          }
        });
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (!session) {
          throw new Error("Expected registered wizard start");
        }
        const answer = (params as WizardNextParams).answer;
        if (answer) {
          expect(answer.value).toBeUndefined();
          await session.answer(answer.stepId, answer.value);
        }
        return session.next();
      }
      if (method === "wizard.cancel") {
        session?.cancel();
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    try {
      const { page } = await mountPage(context, {
        state: { phase: "ready", result: setup },
        client,
        firstRun: false,
      });
      const setupButton = page.querySelector<HTMLButtonElement>(
        '[data-auth-choice="setup-only"] button',
      )!;
      if (operation === "connect") {
        page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
        await waitForFast(() =>
          expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
            "Radius account",
          ),
        );
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
          .find((button) => button.textContent?.includes("Radius account"))!
          .click();
      } else {
        setupButton.click();
      }
      await waitForFast(() => {
        const signIn = page.querySelector(".wizard-step__sign-in");
        expect(signIn).not.toBeNull();
        expect(signIn?.textContent).toContain("Waiting for sign-in");
      });
      expect(page.querySelector(".model-setup-wizard h2")?.textContent?.trim()).toBe(
        operation === "connect" ? "Radius account" : "Setup-only account",
      );
      expect(verificationRuns).toBe(0);
      callback.resolve();
      await waitForFast(
        () =>
          expect(page.textContent).toContain(
            operation === "connect" ? "Provider credentials saved." : "Connection verified",
          ),
        { timeout: 3000 },
      );
      expect(verificationRuns).toBe(operation === "connect" ? 0 : 1);
      expect(page.textContent).not.toContain("Approve this account in your browser.");
      expect(page.textContent).not.toContain("https://example.invalid/authorize");
      expect(setupButton.textContent?.trim()).toBe("Set up & verify");
      expect(
        request.mock.calls.some(([method]) => method === "openclaw.setup.activate.start"),
      ).toBe(false);
      if (operation === "connect") {
        expect(request).toHaveBeenCalledWith(
          "models.authLogin",
          expect.objectContaining({ authChoice: "radius/radius", agentId: "main" }),
          expect.anything(),
        );
        expect(request.mock.calls.some(([method]) => method === "openclaw.setup.auth.start")).toBe(
          false,
        );
      }
    } finally {
      callback.resolve();
      manual.abort();
      session?.cancel();
      await session?.whenSettled();
      runtimeConfig.dispose();
    }
  },
);

it.each(["agent", "connection", "cancel"] as const)(
  "Model Setup discards an account inventory after %s changes",
  async (change) => {
    const { context, client, request, runtimeConfig, snapshot } = createContext();
    const inventory = createDeferred<ModelAuthStatusResult>();
    request.mockImplementation(async (method) => {
      if (method === "models.authStatus") {
        return inventory.promise;
      }
      if (method === "openclaw.setup.detect") {
        return setup;
      }
      if (method === "config.get") {
        return configSnapshot;
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    try {
      const { page } = await mountPage(context, {
        state: { phase: "ready", result: setup },
        client,
        firstRun: false,
      });
      page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "models.authStatus")).toBe(true),
      );
      if (change === "agent") {
        context.settingsAgentSelection.state.selectedId = "other";
      }
      if (change === "connection") {
        snapshot.hello = { ...snapshot.hello };
      }
      if (change === "cancel") {
        page.querySelector<HTMLButtonElement>("openclaw-modal-dialog button")!.click();
      } else {
        page.routeData = { firstRun: false };
      }
      await page.updateComplete;
      inventory.resolve(authStatus);
      await inventory.promise;
      await page.updateComplete;
      expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
    } finally {
      inventory.resolve(authStatus);
      runtimeConfig.dispose();
    }
  },
);

it.each([
  ["connect", "terminal"],
  ["connect", "request"],
  ["setup", "terminal"],
  ["setup", "request"],
] as const)(
  "Model Setup keeps %s recovery context in Details after a %s failure",
  async (operation, failure) => {
    const { context, client, request, runtimeConfig } = createContext();
    vi.spyOn(window, "open").mockReturnValue(null);
    const finish = createDeferred();
    const diagnostic = "Token exchange returned no refresh token.";
    const guidance = "Check the client ID, client secret, and redirect URI.";
    const url = "https://example.invalid/authorize?code=synthetic";
    const authorization = `Open the authorization URL: ${url}`;
    let reads = 0;
    request.mockImplementation(async (method) => {
      if (method === "models.authStatus") {
        return authStatus;
      }
      if (method === "openclaw.setup.detect") {
        return setup;
      }
      if (method === "config.get") {
        return configSnapshot;
      }
      if (method === "models.authLogin" || method === "openclaw.setup.auth.start") {
        expect(method).toBe(
          operation === "connect" ? "models.authLogin" : "openclaw.setup.auth.start",
        );
        return { done: false, status: "running" };
      }
      if (method === "wizard.next") {
        reads += 1;
        if (reads <= 2) {
          return {
            done: false,
            status: "running",
            step: {
              id: `note-${reads}`,
              type: "note",
              executor: "client",
              message: reads === 1 ? guidance : authorization,
            },
          };
        }
        if (reads === 3) {
          return {
            done: false,
            status: "running",
            step: {
              id: "approval",
              type: "progress",
              executor: "gateway",
              message: "Waiting for approval",
              externalUrl: url,
            },
          };
        }
        await finish.promise;
        if (failure === "request") {
          throw new Error(diagnostic);
        }
        return { done: true, status: "error", error: diagnostic };
      }
      if (method === "wizard.cancel") {
        return { status: "cancelled" };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    try {
      const { page } = await mountPage(context, {
        state: { phase: "ready", result: setup },
        client,
        firstRun: false,
      });
      if (operation === "connect") {
        page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
        await waitForFast(() =>
          expect(page.querySelector("openclaw-modal-dialog")?.textContent).toContain(
            "Radius account",
          ),
        );
        [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")]
          .find((button) => button.textContent?.includes("Radius account"))!
          .click();
      } else {
        page.querySelector<HTMLButtonElement>('[data-auth-choice="setup-only"] button')!.click();
      }
      await waitForFast(() =>
        expect(page.querySelector(".wizard-step__sign-in")?.textContent).toContain(
          "Waiting for sign-in",
        ),
      );
      const modal = page.querySelector("openclaw-modal-dialog")!;
      const label = operation === "connect" ? "Radius account" : "Setup-only account";
      expect(modal.querySelector("h2")?.textContent?.trim()).toBe(label);
      expect(modal.textContent).not.toContain(guidance);
      expect(modal.textContent).not.toContain(url);
      finish.resolve();
      await waitForFast(() =>
        expect(modal.querySelector("[role=alert]")?.textContent?.trim()).toBe(
          "Could not finish. Open Details to see what to do next.",
        ),
      );
      expect(modal.querySelector("h2")?.textContent?.trim()).toBe(label);
      expect(modal.querySelector(".wizard-step__sign-in")).toBeNull();
      const details = modal.querySelector<HTMLDetailsElement>("details")!;
      expect(details.open).toBe(false);
      const alert = modal.querySelector("[role=alert]")!;
      expect(alert.textContent).not.toContain(guidance);
      expect(alert.textContent).not.toContain(url);
      details.querySelector("summary")!.click();
      expect(details.open).toBe(true);
      expect(details.querySelector("p")?.textContent).toBe(
        [diagnostic, guidance, authorization].join("\n\n"),
      );
      expect(reads).toBe(4);
      expect(
        request.mock.calls.some(([method]) => method === "openclaw.setup.activate.start"),
      ).toBe(false);
    } finally {
      finish.resolve();
      runtimeConfig.dispose();
    }
  },
);
