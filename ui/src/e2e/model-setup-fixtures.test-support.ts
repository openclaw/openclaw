import type { BrowserContextOptions, Locator, Page } from "playwright";
import { expect } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../api/types.ts";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import type { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import type { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installSetupGateway } from "./model-setup.test-support.ts";

type SetupSuite = ReturnType<typeof createControlUiE2eSuite>;
type SetupPage = Parameters<Parameters<SetupSuite["withPage"]>[1]>[0];
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
type Candidate = SystemAgentSetupDetectResult["candidates"][number];
export const setupRpc = {
  detect: "openclaw.setup.detect",
  activate: "openclaw.setup.activate.start",
  auth: "openclaw.setup.auth.start",
  prepare: "openclaw.setup.prepare.start",
  verify: "openclaw.setup.verify",
  next: "wizard.next",
  cancel: "wizard.cancel",
} as const;

export function setupPages(suite: SetupSuite, options: () => BrowserContextOptions) {
  return <T>(run: (fixture: SetupPage) => Promise<T>, overrides: BrowserContextOptions = {}) =>
    suite.withPage({ ...options(), ...overrides }, run);
}

export const providerLogin = {
  id: "provider-login",
  label: "Provider login",
  kind: "oauth",
  featured: true,
} as const;
export const wizardNotFound = {
  __mockError: {
    code: "INVALID_REQUEST",
    message: "wizard not found",
    details: { code: "WIZARD_NOT_FOUND" },
  },
};
export const localSetupFeatures = [
  "chat.metadata",
  "chat.startup",
  "openclaw.setup.detect",
  "openclaw.setup.activate.start",
  "openclaw.setup.prepare.start",
  "wizard.next",
];

export const activated = (
  modelRef: string,
  options: { gatewayRestartRequired?: boolean } = {},
) => ({ done: true, status: "done", modelActivation: { modelRef, ...options } });

export function activationFailure(error: string, status?: "auth" | "timeout" | "unavailable") {
  return {
    done: true,
    status: "error",
    error,
    ...(status
      ? { activationRejection: { disposition: "rejected-before-promotion", status } }
      : {}),
  };
}

export function localPrepareOptions(llamaHint = "Run a private local model") {
  return (
    [
      ["ollama", "Ollama", "Choose connection"],
      ["llama-cpp", "llama.cpp", "Set up model"],
      ["lmstudio", "LM Studio", "Connect server"],
    ] as const
  ).map(([id, label, actionLabel]) =>
    Object.assign(
      {
        id,
        brandId: id,
        label,
        hint: id === "llama-cpp" ? llamaHint : `Connect to ${label}`,
        actionLabel,
      },
      id === "lmstudio"
        ? {
            icon: "https://cdn.simpleicons.org/lmstudio",
            website: "https://lmstudio.ai/download",
          }
        : {},
    ),
  );
}

export const setupContext = (options: BrowserContextOptions = {}): BrowserContextOptions => ({
  locale: "en-US",
  serviceWorkers: "block",
  ...options,
});

export async function expectText(target: Locator, text: string, absent = false) {
  const assertion = expect.poll(() => target.textContent());
  await (absent ? assertion.not : assertion).toContain(text);
}

export const expectCount = (target: Locator, count: number) =>
  expect.poll(() => target.count()).toBe(count);

export async function expectFocused(target: Locator) {
  await expect
    .poll(() => target.evaluate((element) => document.activeElement === element))
    .toBe(true);
}

export const runningStep = (
  id: string,
  type: WizardStep["type"],
  message: string,
  options: Omit<WizardStep, "id" | "type" | "message"> = {},
) => ({ done: false, status: "running", step: { id, type, message, ...options } });

export const runningWizard = (sessionId?: string) => ({
  done: false,
  status: "running",
  ...(sessionId ? { sessionId } : {}),
});

export function makeDetection(overrides: Partial<SystemAgentSetupDetectResult> = {}) {
  return {
    candidates: [],
    manualProviders: [],
    workspace: "/tmp/openclaw-e2e",
    setupComplete: false,
    ...overrides,
  };
}

export function installLocalSetupGateway(
  page: Page,
  detection: ReturnType<typeof makeDetection>,
  provider: string,
  sequence: unknown[],
) {
  const model = "openai/gpt-5";
  return installSetupGateway(page, {
    agentModel: model,
    models: [{ id: "gpt-5", name: "GPT-5", provider: "openai", available: true }],
    featureMethods: localSetupFeatures,
    methodResponses: {
      "config.get": sourceConfigSnapshot(
        { agents: { defaults: { model } } },
        "before-local-activation",
      ),
      [setupRpc.detect]: detection,
      [setupRpc.prepare]: runningWizard(`${provider}-prepare-session`),
      [setupRpc.activate]: runningWizard("activation-session"),
      [setupRpc.next]: { sequence },
    },
  });
}

export async function expectLocalActivation(
  page: Page,
  gateway: Gateway,
  provider: string,
  modelRef: string,
  icon = provider,
) {
  await page.getByRole("heading", { name: "Connection verified" }).waitFor();
  const success = page.locator(".model-setup-success");
  await expectText(success, modelRef);
  await expectText(success, "Verified in", true);
  await expectCount(success.locator(`[data-provider-icon="${icon}"]`), 1);
  expect((await gateway.waitForRequest(setupRpc.activate)).params).toEqual({
    sessionId: expect.any(String),
    kind: `provider-auto:${provider}`,
    agentId: "main",
    modelRef,
  });
}

export const button = (target: Page | Locator, name: string) =>
  target.getByRole("button", { name, exact: true });

export const waitText = (target: Page | Locator, text: string | RegExp, exact = true) =>
  target.getByText(text, { exact }).waitFor();

export function candidate(
  kind: Candidate["kind"],
  label: string,
  modelRef: string,
  options: Partial<Candidate> = {},
) {
  return {
    kind,
    label,
    modelRef,
    detail: "Available on this Gateway",
    recommended: false,
    credentials: true,
    ...options,
  };
}

export async function returnToLocalModelSettings(
  page: Page,
  gateway: Gateway,
  options: { provider: string; label: string; icon: string; model: string; hash: string },
) {
  const { provider, label, icon, model, hash } = options;
  const modelRef = `${provider}/${model}`;
  const globalModel = "openai/gpt-5";
  // Publish agent defaults and catalog facts; the global default must remain unchanged.
  const agents = {
    defaults: { model: globalModel },
    entries: { main: { model: { primary: modelRef } } },
  };
  await gateway.setMethodResponse("config.get", sourceConfigSnapshot({ agents }, hash));
  await gateway.setMethodResponse("models.list", {
    models: [
      { id: "gpt-5", name: "GPT-5", provider: "openai", available: true },
      { id: model, name: model, provider, available: true },
    ],
  });
  await gateway.setMethodResponse("models.authStatus", {
    ts: 2,
    providerCapabilities: [],
    providers: [{ provider, displayName: label, status: "static", profiles: [] }],
  });
  await gateway.emitGatewayEvent("config.changed", {});
  await gateway.emitGatewayEvent("chat.metadata.changed", {
    agentId: "main",
    modelCatalogChanged: true,
    authChanged: true,
  });
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.getByRole("button", { name: "Return to Models" }).click();
  await expectCount(page.locator("openclaw-modal-dialog"), 0);
  expect(new URL(page.url()).pathname).toBe("/settings/model-providers");
  const connection = page.locator(`[data-provider-id="${provider}"]`);
  await connection.getByText(label, { exact: true }).waitFor();
  const picker = page.locator(".model-providers__defaults openclaw-select-picker").first();
  await picker.locator(".picker-select__trigger").click();
  await picker.locator(`[role="option"][data-value="${modelRef}"]`).waitFor({ state: "visible" });
  await picker.locator(".picker-select__trigger").click();
  await expectCount(connection.locator(`[data-provider-icon="${icon}"]`), 1);
  await expect.poll(() => pickerValue(picker)).toBe(globalModel);
}

export async function expectRequestCounts(gateway: Gateway, counts: Record<string, number>) {
  for (const [method, count] of Object.entries(counts)) {
    expect(await gateway.getRequests(method), method).toHaveLength(count);
  }
}

export const pollRequestCount = (gateway: Gateway, method: string) =>
  expect.poll(async () => (await gateway.getRequests(method)).length);
