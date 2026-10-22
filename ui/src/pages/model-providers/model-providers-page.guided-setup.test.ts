/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { WizardNextParams } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  appendPage,
  createAuthStatus,
  createHarness,
  expandProvider,
  waitForProviders,
} from "./model-providers-page.test-support.tsx";

it("runs a provider-card setup wizard with sibling actions disabled and the model preserved", async () => {
  const { context, request } = createHarness("main");
  const originalRequest = request.getMockImplementation()!;
  const config = { agents: { defaults: { model: "existing/preserved" } } };
  const providerIds = ["guided-first", "guided-second"];
  let session: WizardSession | undefined;
  request.mockImplementation(async (method, params?: Partial<WizardNextParams>) => {
    if (method === "models.authStatus") {
      return {
        ...createAuthStatus(
          providerIds.map((provider) => ({
            provider,
            displayName: provider,
            profiles: [{ profileId: `${provider}:saved`, type: "token", status: "ok" }],
          })),
        ),
        providerCapabilities: providerIds.map((provider) => ({
          provider,
          apiKeySupported: false,
          quickApiKeySetup: false,
          setupActions: [{ choiceId: provider, label: provider, actionLabel: "Reconnect" }],
        })),
      };
    }
    if (method === "config.get") {
      return { config, hash: "guided-config", valid: true };
    }
    if (method === "openclaw.setup.prepare.start") {
      session = new WizardSession(async (prompter) => {
        await prompter.text({ message: "Provider session key", sensitive: true });
      });
      return { done: false, status: "running" };
    }
    if (method === "wizard.next") {
      if (!session) {
        throw new Error("Provider setup has not started");
      }
      if (params?.answer) {
        await session.answer(params.answer.stepId, params.answer.value);
      }
      return session.next();
    }
    return originalRequest(method);
  });
  const page = appendPage(context);
  await waitForProviders(page, config);
  for (const provider of providerIds) {
    await expandProvider(page, provider);
  }
  const action = (provider: string) =>
    page.querySelector<HTMLButtonElement>(`[data-models-setup-provider="${provider}"]`);
  expect(action("guided-first")?.textContent?.trim()).toBe("Reconnect");
  action("guided-first")!.click();
  await waitForSolid(() => {
    expect(page.renderRoot.textContent).toContain("Provider session key");
    expect(action("guided-second")?.disabled).toBe(true);
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);
  });
  const input = page.querySelector<HTMLInputElement>('input[name="wizard-text"]')!;
  expect(input.type).toBe("password");
  input.value = "synthetic-session-key";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn.primary")!.click();
  await waitForSolid(() =>
    expect(page.renderRoot.textContent).toContain(
      "Provider configured. The active model has not changed.",
    ),
  );
  expect(session?.getStatus()).toBe("done");
  expect(page.view.props.defaultModels.primary).toBe("existing/preserved");
});
