/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult, WizardNextResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { mountPage } from "./test-helpers/page.test-support.ts";
import type { TestModelSetupPage } from "./test-helpers/solid-page.test-support.tsx";

export { mountPage };

export function authOption(
  id: string,
  label = "Provider",
  kind: SystemAgentSetupDetectResult["authOptions"][number]["kind"] = "oauth",
  featured = true,
): SystemAgentSetupDetectResult["authOptions"][number] {
  return { id, label, kind, featured };
}

export function activated(
  modelRef: string,
  details: Partial<NonNullable<WizardNextResult["modelActivation"]>> = {},
) {
  return { done: true, status: "done" as const, modelActivation: { modelRef, ...details } };
}

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
  request: ReturnType<typeof createFirstRunContext>["request"],
  handlers: Record<string, (params: unknown) => unknown>,
) {
  request.mockImplementation(async (method, params) => {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unexpected method ${method}`);
    }
    return handler(params);
  });
}

function mutableGatewaySnapshot(snapshot: ApplicationGateway["snapshot"]) {
  return snapshot;
}

export function createFirstRunContext(refreshError?: string, beforeRefresh?: () => Promise<void>) {
  const request =
    vi.fn<(...args: Parameters<GatewayBrowserClient["request"]>) => Promise<unknown>>();
  const client = createTestGatewayClient(request);
  const listeners = new Set<(snapshot: ApplicationGateway["snapshot"]) => void>();
  const snapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: {
        role: "operator",
        scopes: ["operator.read", "operator.admin"],
        recoveryScope: "synthetic-setup-owner",
      },
      features: {
        methods: [
          "config.set",
          "openclaw.setup.detect",
          "openclaw.setup.verify",
          "openclaw.setup.activate.start",
          "openclaw.setup.prepare.start",
        ],
      },
    },
    canvasPluginSurfaceUrl: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } satisfies ApplicationGateway["snapshot"];
  const gateway = {
    snapshot: mutableGatewaySnapshot(snapshot),
    connection: {
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      token: "test-token",
      password: "",
      bootstrapToken: "",
    },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    loadSelfProfile: async () => null,
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: (listener: (next: ApplicationGateway["snapshot"]) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
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
    gateway,
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      subscribe: () => () => undefined,
    },
    settingsAgentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      subscribe: () => () => undefined,
    },
    basePath: "/openclaw",
    resourceBasePath: "/openclaw",
    navigate: vi.fn(),
    runtimeConfig: { ...runtimeConfig, runExternalMutation },
    // SAFETY: the first-run page consumes only the gateway, agent selection,
    // navigation, and runtime config fixtures defined above.
  } as unknown as ApplicationContext;
  return {
    client,
    context,
    request,
    snapshot,
    publishGatewaySnapshot: (next: ApplicationGateway["snapshot"]) => {
      gateway.snapshot = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
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
  await waitForFast(() => {
    const candidateButton = page.querySelector<HTMLButtonElement>(
      `[data-candidate-kind="${kind}"] button`,
    );
    expect(candidateButton).not.toBeNull();
    expect(candidateButton!.disabled).toBe(false);
  });
  const button = page.querySelector<HTMLButtonElement>(`[data-candidate-kind="${kind}"] button`);
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  button!.click();
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
