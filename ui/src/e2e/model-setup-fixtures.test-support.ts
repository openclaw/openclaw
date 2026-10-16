import path from "node:path";
import type { BrowserContextOptions, Locator, Page } from "playwright";
import { beforeEach, expect } from "vitest";
import type { SystemAgentSetupDetectResult, WizardStep } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";

export function setupContext(
  options: BrowserContextOptions = {},
  videoDir?: string,
): BrowserContextOptions {
  return {
    locale: "en-US",
    serviceWorkers: "block",
    ...options,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: options.viewport ?? undefined } } : {}),
  };
}

export function setupArtifacts(name: string) {
  const root = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  const artifacts: { dir?: string } = {};
  beforeEach(() => {
    artifacts.dir = root ? createControlUiE2eArtifactDir(name, root) : undefined;
  });
  return artifacts;
}

export async function screenshot(
  page: Page,
  directory: string | undefined,
  name: string,
  options: Parameters<Page["screenshot"]>[0] = {},
) {
  if (directory) {
    await page.screenshot({ ...options, path: path.join(directory, name) });
  }
}

export function fullScreenshot(page: Page, directory: string | undefined, name: string) {
  return screenshot(page, directory, name, { animations: "disabled", fullPage: true });
}

export async function expectText(target: Locator, text: string, absent = false) {
  const assertion = expect.poll(() => target.textContent());
  await (absent ? assertion.not : assertion).toContain(text);
}

export async function expectCount(target: Locator, count: number) {
  await expect.poll(() => target.count()).toBe(count);
}

export async function expectFocused(target: Locator) {
  await expect
    .poll(() => target.evaluate((element) => document.activeElement === element))
    .toBe(true);
}

export function runningStep(
  id: string,
  type: WizardStep["type"],
  message: string,
  options: Omit<WizardStep, "id" | "type" | "message"> = {},
) {
  return { done: false, status: "running", step: { id, type, message, ...options } };
}

export function runningWizard(sessionId?: string) {
  return { done: false, status: "running", ...(sessionId ? { sessionId } : {}) };
}

export function makeDetection(overrides: Partial<SystemAgentSetupDetectResult> = {}) {
  return {
    candidates: [],
    manualProviders: [],
    workspace: "/tmp/openclaw-e2e",
    setupComplete: false,
    ...overrides,
  };
}

export function configSnapshot(config: object, hash: string) {
  return {
    config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    hash,
    valid: true,
    issues: [],
  };
}

export function button(target: Page | Locator, name: string) {
  return target.getByRole("button", { name, exact: true });
}

export function candidate(
  kind: SystemAgentSetupDetectResult["candidates"][number]["kind"],
  label: string,
  modelRef: string,
  options: Pick<SystemAgentSetupDetectResult["candidates"][number], "detail"> &
    Partial<SystemAgentSetupDetectResult["candidates"][number]>,
) {
  return { kind, label, modelRef, recommended: false, credentials: true, ...options };
}

export async function returnToLocalModelSettings(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  options: { provider: string; label: string; icon: string; model: string; hash: string },
) {
  const { provider, label, icon, model, hash } = options;
  const modelRef = `${provider}/${model}`;
  const globalModel = "openai/gpt-5";
  // Publish agent defaults and catalog facts; the global default must remain unchanged.
  await gateway.setMethodResponse(
    "config.get",
    configSnapshot(
      {
        agents: {
          defaults: { model: globalModel },
          entries: { main: { model: { primary: modelRef } } },
        },
      },
      hash,
    ),
  );
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

export async function expectRequestCounts(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  counts: Record<string, number>,
) {
  for (const [method, count] of Object.entries(counts)) {
    expect(await gateway.getRequests(method), method).toHaveLength(count);
  }
}
