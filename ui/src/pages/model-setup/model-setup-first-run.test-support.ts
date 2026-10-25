/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ModelCatalogEntry,
  SystemAgentSetupDetectResult,
  WizardNextResult,
} from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./test-helpers/page.test-support.ts";
import type { TestModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

const onboarding = { search: "?onboarding=1" };
export const waitForOnboarding = (context: Pick<ApplicationContext, "navigate">) =>
  waitForFast(() => expect(context.navigate).toHaveBeenCalledWith("custodian", onboarding));

export const missingWizardError = () =>
  new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "wizard not found",
    details: { code: "WIZARD_NOT_FOUND" },
  });

export const running = { done: false, status: "running" } as const;

export const nativeModel = (name = "Fixture model"): ModelCatalogEntry => ({
  provider: "acp-opencode",
  id: "fixture-model",
  name,
  available: true,
  agentRuntime: { id: "acp-opencode", source: "implicit" },
});

export const configuredDetection = (configuredModel: string) => ({
  ...detection,
  configuredModel,
  setupComplete: true,
});

export function authOption(
  id: string,
  label = "Provider",
  kind: NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number]["kind"] = "oauth",
  featured = true,
): NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number] {
  return { id, label, kind, featured };
}

export function activated(
  modelRef: string,
  details: Partial<NonNullable<WizardNextResult["modelActivation"]>> = {},
) {
  return { done: true, status: "done" as const, modelActivation: { modelRef, ...details } };
}

export const runningStep = (step: NonNullable<WizardNextResult["step"]>) => ({
  done: false,
  status: "running" as const,
  step,
});

export const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [],
  recommendedInstalls: [],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

export function useFirstRunFixtures(privateKey: string, restoreTimers = false, session = false) {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    if (session) {
      vi.stubGlobal("sessionStorage", createStorageMock());
    }
    localStorage.setItem("openclaw-device-identity-v1", JSON.stringify({ version: 1, privateKey }));
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    if (restoreTimers) {
      vi.useRealTimers();
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}

export const pendingReceipt = () =>
  localStorage.getItem("openclaw.modelSetup.pendingActivation.v1");

export function mockRequests(
  request: {
    mockImplementation: (
      handler: (method: string, params?: unknown) => Promise<unknown>,
    ) => unknown;
  },
  handlers: Record<string, (params: unknown) => unknown>,
) {
  request.mockImplementation(async (method, params) => {
    const handler = handlers[method];
    if (!Object.hasOwn(handlers, method) || !handler) {
      throw new Error(`Unexpected method ${method}`);
    }
    return handler(params);
  });
}

export function createFirstRunContext(refreshError?: string, beforeRefresh?: () => Promise<void>) {
  const base = createContext();
  // Replace the base capability only after installing the publishing Gateway.
  base.runtimeConfig.dispose();
  const { request } = base;
  const client = createTestGatewayClient(request);
  const snapshot = {
    ...base.snapshot,
    client,
    phase: "connected" as const,
    offlineStable: false,
    hello: {
      ...base.snapshot.hello,
      auth: { ...base.snapshot.hello.auth, recoveryScope: "synthetic-setup-owner" },
    },
    canvasPluginSurfaceUrl: null,
  } satisfies ApplicationGateway["snapshot"];
  const publication = createApplicationGateway(snapshot);
  const gateway = {
    ...base.context.gateway,
    get snapshot() {
      return publication.gateway.snapshot;
    },
    connectionRevision: 0,
    eventLogRevision: 0,
    loadSelfProfile: async () => null,
    subscribe: publication.gateway.subscribe,
  } satisfies ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const runExternalMutation = vi.fn(
    async (task: (connectedClient: GatewayBrowserClient) => Promise<unknown>) => {
      try {
        const value = await task(client);
        await beforeRefresh?.();
        return {
          ok: true as const,
          value,
          refresh: refreshError
            ? { ok: false as const, error: refreshError }
            : { ok: true as const },
        };
      } catch (error) {
        return {
          ok: false as const,
          reason: "error" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
  const context = {
    ...base.context,
    gateway,
    runtimeConfig: { ...runtimeConfig, runExternalMutation },
  } as unknown as ApplicationContext;
  return {
    client,
    context,
    request,
    snapshot,
    publishGatewaySnapshot: publication.publish,
  };
}

export function mountDetection(
  context: ApplicationContext,
  client: GatewayBrowserClient,
  result: Partial<SystemAgentSetupDetectResult> = {},
  firstRun = true,
) {
  return mountPage(context, {
    client,
    firstRun,
    state: { phase: "ready", result: { ...detection, ...result } },
  });
}

export function modalButton(page: ParentNode, label: string) {
  return [...page.querySelectorAll<HTMLButtonElement>("openclaw-modal-dialog button")].find(
    (button) => button.textContent?.trim() === label,
  );
}

export const pageButton = (page: ParentNode, selector: string) =>
  page.querySelector<HTMLButtonElement>(selector);

export const authButton = (page: ParentNode, id: string) =>
  pageButton(page, `[data-auth-choice="${id}"] button`);

export const waitForElement = (page: ParentNode, selector: string) =>
  waitForFast(() => expect(page.querySelector(selector)).not.toBeNull());

export const waitForText = (page: Node, text: string) =>
  waitForFast(() => expect(page.textContent).toContain(text));

export async function reconnectGateway(
  page: TestModelSetupPage,
  snapshot: ReturnType<typeof createFirstRunContext>["snapshot"],
  publish: (snapshot: ApplicationGateway["snapshot"]) => void,
) {
  publish({ ...snapshot, phase: "reconnecting", hello: null });
  await page.updateComplete;
  publish({ ...snapshot, phase: "connected", hello: { ...snapshot.hello } });
}

export function callsFor<T extends readonly unknown[]>(
  request: { mock: { calls: T[] } },
  method: string,
) {
  return request.mock.calls.filter(([name]) => name === method);
}

export function setInput(page: ParentNode, selector: string, value: string) {
  const input = page.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function answerWizard(
  page: TestModelSetupPage,
  value: string,
  selector = "#model-setup-wizard-text-input",
) {
  setInput(page, selector, value);
  await page.updateComplete;
  page
    .querySelector<HTMLFormElement>("openclaw-modal-dialog form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

export async function enterManualKey(page: TestModelSetupPage, provider: string, key: string) {
  await selectManualProvider(page, provider);
  setInput(page, 'input[type="password"]', key);
  page.querySelector<HTMLButtonElement>(".model-setup__manual .btn.primary")!.click();
}

export function candidate(
  kind: SystemAgentSetupDetectResult["candidates"][number]["kind"],
  modelRef: string,
  credentials?: boolean,
): SystemAgentSetupDetectResult["candidates"][number] {
  return {
    kind,
    label: kind,
    detail: "Available on this Gateway",
    modelRef,
    recommended: false,
    ...(credentials === undefined ? {} : { credentials }),
  };
}

export function requestParameters(params: unknown) {
  if (!params || typeof params !== "object") {
    throw new Error("Expected Gateway request parameters.");
  }
  return params;
}

export async function clickCandidate(page: TestModelSetupPage, kind: string) {
  const readyButton = () => {
    const button = pageButton(page, `[data-candidate-kind="${kind}"] button`);
    expect(button).toMatchObject({ disabled: false });
    return button!;
  };
  await waitForFast(readyButton);
  readyButton().click();
  await page.updateComplete;
}

export async function selectManualProvider(page: TestModelSetupPage, providerId: string) {
  const picker = page.querySelector(".model-setup-provider-select")!;
  const trigger = picker.querySelector<HTMLButtonElement>(".model-setup-provider-select__trigger")!;
  trigger.click();
  await waitForSolid(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  const item = picker.querySelector<HTMLButtonElement>(`[data-manual-provider="${providerId}"]`);
  expect(item).not.toBeNull();
  item!.click();
  await page.updateComplete;
}

export async function waitForModelSetupDetection(page: TestModelSetupPage): Promise<void> {
  await page.updateComplete;
  await waitForFast(() =>
    expect(page.querySelector(".model-setup")?.getAttribute("aria-busy")).toBe("false"),
  );
}
