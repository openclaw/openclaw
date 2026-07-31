/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/index.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../test-helpers/application-context.ts";
import type { ModelSetupRouteData } from "./model-setup-page.ts";
import "./model-setup-page.ts";

type TestModelSetupPage = HTMLElement & {
  routeData?: ModelSetupRouteData;
  updateComplete: Promise<boolean>;
};

const recommendedIconUrl = "https://cdn.simpleicons.org/ollama";
const customIconUrl = "https://cdn.example.com/acme.png";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Connect to an Ollama server and select a cloud or local model",
    },
    {
      id: "llama-cpp",
      brandId: "llama-cpp",
      label: "Local model (llama.cpp)",
      hint: "Download and run a private GGUF model",
    },
    {
      id: "lmstudio",
      brandId: "lmstudio",
      label: "LM Studio",
      hint: "Connect to a running LM Studio server and use an already loaded model",
    },
  ],
  recommendedInstalls: [
    {
      id: "ollama",
      brandId: "ollama",
      label: "Ollama",
      hint: "Run open models locally",
      website: "https://ollama.com/download",
      icon: recommendedIconUrl,
    },
  ],
  workspace: "/tmp/workspace",
  setupComplete: false,
};

function createContext() {
  const request = vi.fn<GatewayBrowserClient["request"]>();
  const client = { request } as unknown as GatewayBrowserClient;
  const gatewayListeners = new Set<(snapshot: ApplicationGateway["snapshot"]) => void>();
  const snapshot = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: {
        methods: [
          "openclaw.setup.detect",
          "openclaw.setup.verify",
          "openclaw.setup.activate",
          "openclaw.setup.prepare.start",
        ],
      },
    },
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const gateway = {
    snapshot,
    connection: {
      gatewayUrl: window.location.origin.replace(/^http/u, "ws"),
      token: "test-token",
      password: "",
      bootstrapToken: "",
    },
    eventLog: [],
    connect: () => undefined,
    setSessionKey: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: (listener: (next: ApplicationGateway["snapshot"]) => void) => {
      gatewayListeners.add(listener);
      return () => gatewayListeners.delete(listener);
    },
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const setGatewayPhase = (phase: "connected" | "reconnecting") => {
    const mutableGateway = gateway as { snapshot: ApplicationGateway["snapshot"] };
    mutableGateway.snapshot = {
      ...gateway.snapshot,
      phase,
      hello: phase === "connected" ? snapshot.hello : null,
    } as ApplicationGateway["snapshot"];
    for (const listener of gatewayListeners) {
      listener(mutableGateway.snapshot);
    }
  };
  return {
    client,
    request,
    runtimeConfig,
    setGatewayPhase,
    context: {
      gateway,
      basePath: "/openclaw",
      navigate: vi.fn(),
      runtimeConfig,
    } as unknown as ApplicationContext,
  };
}

async function mountPage(
  context: ApplicationContext,
  routeData: ModelSetupRouteData,
): Promise<{ page: TestModelSetupPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  page.routeData = routeData;
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  return { page, provider };
}

describe("ModelSetupPage catalog icons", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses bundled brand icons without enqueueing their remote artwork", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    expect(
      page.querySelector('.model-setup__recommendation [data-provider-icon="ollama"]'),
    ).not.toBeNull();
    expect(page.querySelector(".model-setup__recommendation img")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(page.innerHTML).not.toContain(recommendedIconUrl);
  });

  it("loads unknown wire icons through the authenticated same-origin catalog proxy", async () => {
    const NativeUrl = URL;
    const createObjectURL = vi.fn(() => "blob:acme-icon");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = createObjectURL;
        static override revokeObjectURL = revokeObjectURL;
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          recommendedInstalls: [
            {
              id: "acme",
              label: "Acme",
              hint: "Install the Acme runtime",
              website: "https://example.com/acme",
              icon: customIconUrl,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    await vi.waitFor(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:acme-icon");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(customIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.innerHTML).not.toContain(customIconUrl);

    page.remove();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:acme-icon");
  });

  it("keeps legacy known-provider artwork on the authenticated proxy path", async () => {
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL = vi.fn(() => "blob:legacy-ollama");
        static override revokeObjectURL = vi.fn();
      },
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const { context, client } = createContext();
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          recommendedInstalls: detection.recommendedInstalls?.map(
            ({ brandId: _brandId, ...entry }) => entry,
          ),
        },
      },
      client,
      firstRun: false,
    });

    await vi.waitFor(() => {
      expect(
        page
          .querySelector<HTMLImageElement>(".model-setup__recommendation img")
          ?.getAttribute("src"),
      ).toBe("blob:legacy-ollama");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw/__openclaw__/catalog-icon/${encodeURIComponent(recommendedIconUrl)}`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(page.querySelector(".model-setup__recommendation [data-provider-icon]")).toBeNull();
  });

  it("starts a prepare wizard from the download affordance", async () => {
    const { context, client, request } = createContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: {
            id: "download",
            type: "progress",
            message: "Downloading model: 25%",
          },
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.prepare.start",
        { sessionId: expect.any(String), authChoice: "llama-cpp" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(page.textContent).toContain("Downloading model: 25%");
    });
  });

  it("flushes the draft before wizard setup and adopts the committed configuration", async () => {
    vi.useFakeTimers();
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    request.mockImplementation(async (method: string, params?: unknown) => {
      order.push(method);
      if (method === "config.get") {
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        config = { ...config, configuredModel: "provider/test-model" };
        hash = "hash-3";
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, setupComplete: true, configuredModel: "provider/test-model" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();

    await vi.waitFor(() => {
      expect(order).toEqual([
        "config.set",
        "openclaw.setup.auth.start",
        "wizard.next",
        "config.get",
        "openclaw.setup.detect",
      ]);
    });
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      configuredModel: "provider/test-model",
    });
    expect(page.textContent).toContain("provider/test-model");
    runtimeConfig.dispose();
  });

  it("surfaces refresh failures when a Gateway-owned wizard finishes asynchronously", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let resolveWizard!: (value: { done: true; status: "done" }) => void;
    const wizardCompletion = new Promise<{ done: true; status: "done" }>((resolve) => {
      resolveWizard = resolve;
    });
    let nextCalls = 0;
    let mutationCalls = 0;
    let mutationQueue = Promise.resolve();
    const runExternalMutation = vi.fn((task: (gateway: GatewayBrowserClient) => unknown) => {
      const run = async () => ({
        ok: true as const,
        value: await task(client),
        refresh:
          mutationCalls++ === 0
            ? { ok: false as const, error: "delayed auth refresh failed" }
            : { ok: true as const },
      });
      const queued = mutationQueue.then(run, run);
      mutationQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return nextCalls++ === 0
          ? {
              done: false,
              status: "running",
              step: {
                id: "authorize",
                type: "progress",
                executor: "gateway",
                message: "Authorizing provider",
              },
            }
          : wizardCompletion;
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, setupComplete: true, configuredModel: "provider/async-model" };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => {
      expect(nextCalls).toBe(2);
      expect((page as unknown as { wizardMutationActive: boolean }).wizardMutationActive).toBe(
        true,
      );
    });

    let competingMutationStarted = false;
    const competingMutation = runExternalMutation(async () => {
      competingMutationStarted = true;
    });
    await Promise.resolve();
    expect(competingMutationStarted).toBe(false);

    resolveWizard({ done: true, status: "done" });

    await vi.waitFor(() => {
      expect(page.textContent).toContain("provider/async-model");
      expect(page.textContent).toContain("delayed auth refresh failed");
      expect(runExternalMutation).toHaveBeenCalledTimes(2);
    });
    await competingMutation;
    expect(competingMutationStarted).toBe(true);
    baseRuntimeConfig.dispose();
  });

  it("adds committed refresh warnings to failed Gateway-owned progress", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: false as const, error: "gateway progress refresh failed" },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    let nextCalls = 0;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (nextCalls++ === 0) {
          return {
            done: false,
            status: "running",
            step: { id: "authorize", type: "progress", executor: "gateway", message: "Waiting" },
          };
        }
        throw new Error("gateway progress failed");
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("gateway progress failed");
      expect(page.textContent).toContain("gateway progress refresh failed");
    });
    baseRuntimeConfig.dispose();
  });

  it("retains a committed refresh warning across a later human-input wizard step", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let nextCalls = 0;
    let mutationCalls = 0;
    const answerCompletion = deferred<{ done: true; status: "done" }>();
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh:
        mutationCalls++ === 0
          ? { ok: false as const, error: "intermediate auth refresh failed" }
          : { ok: true as const },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return nextCalls++ === 0
          ? {
              done: false,
              status: "running",
              step: { id: "confirm", type: "confirm", message: "Continue setup?" },
            }
          : answerCompletion.promise;
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, setupComplete: true, configuredModel: "provider/confirmed-model" };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => {
      expect(page.textContent).toContain("Continue setup?");
      expect(page.textContent).toContain("intermediate auth refresh failed");
    });

    const owner = page as unknown as {
      runWizardMutation: (task: () => Promise<void>) => Promise<unknown>;
      wizard: { answer: (value: unknown) => Promise<void> };
    };
    const answerMutation = owner.runWizardMutation(() => owner.wizard.answer(true));
    await vi.waitFor(() => {
      const state = (page as unknown as { wizardState: { phase: string; busy?: boolean } })
        .wizardState;
      expect(state.phase).toBe("step");
      expect(state.busy).toBe(true);
      expect(page.textContent).toContain("intermediate auth refresh failed");
    });
    answerCompletion.resolve({ done: true, status: "done" });
    await answerMutation;

    await vi.waitFor(() => {
      expect(page.textContent).toContain("provider/confirmed-model");
      expect(page.textContent).toContain("intermediate auth refresh failed");
    });
    baseRuntimeConfig.dispose();
  });

  it("preserves an earlier refresh warning when a later wizard answer fails", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let nextCalls = 0;
    let mutationCalls = 0;
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => {
      if (mutationCalls++ > 0) {
        return { ok: false as const, reason: "error" as const, error: "wizard answer rejected" };
      }
      return {
        ok: true as const,
        value: await task(client),
        refresh: { ok: false as const, error: "intermediate auth refresh failed" },
      };
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next" && nextCalls++ === 0) {
        return {
          done: false,
          status: "running",
          step: { id: "confirm", type: "confirm", message: "Continue setup?" },
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Continue setup?"));

    const owner = page as unknown as {
      runWizardMutation: (task: () => Promise<void>) => Promise<unknown>;
      wizard: { answer: (value: unknown) => Promise<void> };
    };
    await owner.runWizardMutation(() => owner.wizard.answer(true));

    await vi.waitFor(() => {
      expect(page.textContent).toContain("wizard answer rejected");
      expect(page.textContent).toContain("intermediate auth refresh failed");
    });
    (page as unknown as { closeWizard: () => void }).closeWizard();
    await page.updateComplete;
    expect(page.textContent).toContain("intermediate auth refresh failed");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "intermediate auth refresh failed",
    );
    baseRuntimeConfig.dispose();
  });

  it("surfaces an earlier committed refresh warning when a wizard is cancelled", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: false as const, error: "committed setup refresh failed" },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "confirm", type: "confirm", message: "Continue setup?" },
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Continue setup?"));

    const owner = page as unknown as { cancelWizard: () => void; closeWizard: () => void };
    owner.cancelWizard();

    await vi.waitFor(() => expect(page.textContent).toContain("committed setup refresh failed"));
    owner.closeWizard();
    await page.updateComplete;
    expect(page.textContent).toContain("committed setup refresh failed");
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      "committed setup refresh failed",
    );
    baseRuntimeConfig.dispose();
  });

  it("invalidates setup tasks and detects again after a same-client reconnect", async () => {
    const { context, client, request, runtimeConfig, setGatewayPhase } = createContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [
            {
              kind: "existing-model",
              label: "Recovered model",
              detail: "Loaded after reconnect",
              modelRef: "provider/recovered",
              recommended: true,
              credentials: true,
            },
          ],
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });
    const owner = page as unknown as {
      activationState: { phase: string; targetId?: string; modelRef?: string };
      wizardState: { phase: string };
    };
    owner.activationState = {
      phase: "testing",
      targetId: "stale-model",
      modelRef: "provider/stale",
    };
    await page.updateComplete;

    setGatewayPhase("reconnecting");
    await page.updateComplete;

    expect(owner.activationState.phase).toBe("idle");
    expect(owner.wizardState.phase).toBe("idle");

    setGatewayPhase("connected");

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.detect",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(page.textContent).toContain("Recovered model");
    });
    runtimeConfig.dispose();
  });

  it("keeps a committed human-step refresh warning visible across reconnect", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
      setGatewayPhase,
    } = createContext();
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: false as const, error: "human-step refresh failed before reconnect" },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return {
          done: false,
          status: "running",
          step: { id: "confirm", type: "confirm", message: "Continue setup?" },
        };
      }
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("human-step refresh failed before reconnect"),
    );

    setGatewayPhase("reconnecting");
    await page.updateComplete;
    expect(page.textContent).toContain("human-step refresh failed before reconnect");
    setGatewayPhase("connected");

    await vi.waitFor(() => {
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "human-step refresh failed before reconnect",
      );
    });
    baseRuntimeConfig.dispose();
  });

  it("drops a queued wizard mutation across a same-client reconnect", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
      setGatewayPhase,
    } = createContext();
    let releaseMutation!: () => void;
    const pendingMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => {
      await pendingMutation;
      try {
        return { ok: true as const, value: await task(client), refresh: { ok: true as const } };
      } catch (error) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: (error as Error).message,
        };
      }
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      throw new Error(`Unexpected stale method ${method}`);
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(runExternalMutation).toHaveBeenCalledOnce());

    setGatewayPhase("reconnecting");
    await page.updateComplete;
    setGatewayPhase("connected");
    await page.updateComplete;
    releaseMutation();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.detect",
        {},
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      expect.anything(),
      expect.anything(),
    );
    baseRuntimeConfig.dispose();
  });

  it("does not finalize an old wizard after same-client reconnect interrupts detection", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
      setGatewayPhase,
    } = createContext();
    let completeDetection!: (value: SystemAgentSetupDetectResult) => void;
    const staleDetection = new Promise<SystemAgentSetupDetectResult>((resolve) => {
      completeDetection = resolve;
    });
    let detections = 0;
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: true as const },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return detections++ === 0 ? staleDetection : detection;
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(detections).toBe(1));

    setGatewayPhase("reconnecting");
    await page.updateComplete;
    setGatewayPhase("connected");
    await vi.waitFor(() => expect(detections).toBe(2));
    completeDetection({
      ...detection,
      setupComplete: true,
      configuredModel: "provider/stale-model",
    });
    await staleDetection;
    await page.updateComplete;

    expect(page.textContent).not.toContain("provider/stale-model");
    expect((page as unknown as { activationState: { phase: string } }).activationState.phase).toBe(
      "idle",
    );
    baseRuntimeConfig.dispose();
  });

  it("detects again after a pre-reconnect wizard commits on the current connection", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
      setGatewayPhase,
    } = createContext();
    let finishProgress!: () => void;
    const progress = new Promise<void>((resolve) => {
      finishProgress = resolve;
    });
    let nextCalls = 0;
    let detectCalls = 0;
    let committed = false;
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: true as const },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (nextCalls++ === 0) {
          return {
            done: false,
            status: "running",
            step: { id: "authorize", type: "progress", executor: "gateway", message: "Waiting" },
          };
        }
        await progress;
        committed = true;
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        detectCalls += 1;
        return committed
          ? { ...detection, setupComplete: true, configuredModel: "provider/reconnected-model" }
          : detection;
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(nextCalls).toBe(2));

    setGatewayPhase("reconnecting");
    await page.updateComplete;
    setGatewayPhase("connected");
    await vi.waitFor(() => expect(detectCalls).toBe(1));
    expect(page.textContent).not.toContain("provider/reconnected-model");

    finishProgress();

    await vi.waitFor(() => {
      expect(detectCalls).toBe(2);
      expect(page.textContent).toContain("provider/reconnected-model");
    });
    expect((page as unknown as { activationState: { phase: string } }).activationState.phase).toBe(
      "idle",
    );
    baseRuntimeConfig.dispose();
  });

  it("retains a late committed refresh warning while its Gateway is reconnecting", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
      setGatewayPhase,
    } = createContext();
    const progress = deferred<void>();
    let nextCalls = 0;
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: { ok: false as const, error: "refresh failed during Gateway reconnect" },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (nextCalls++ === 0) {
          return {
            done: false,
            status: "running",
            step: { id: "authorize", type: "progress", executor: "gateway", message: "Waiting" },
          };
        }
        await progress.promise;
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(nextCalls).toBe(2));

    setGatewayPhase("reconnecting");
    await page.updateComplete;
    progress.resolve();
    await vi.waitFor(() =>
      expect(page.textContent).toContain("refresh failed during Gateway reconnect"),
    );
    setGatewayPhase("connected");

    await vi.waitFor(() => {
      expect(page.textContent).toContain("refresh failed during Gateway reconnect");
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "refresh failed during Gateway reconnect",
      );
    });
    baseRuntimeConfig.dispose();
  });

  it("invalidates a queued wizard mutation when its page is removed", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let releaseMutation!: () => void;
    const pendingMutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => {
      await pendingMutation;
      try {
        return { ok: true as const, value: await task(client), refresh: { ok: true as const } };
      } catch (error) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: (error as Error).message,
        };
      }
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(runExternalMutation).toHaveBeenCalledOnce());
    const queued = runExternalMutation.mock.results[0]?.value as Promise<unknown>;

    page.remove();
    releaseMutation();
    await queued;

    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.auth.start",
      expect.anything(),
      expect.anything(),
    );
    baseRuntimeConfig.dispose();
  });

  it("preserves a pending refresh failure when a cancelled Gateway wizard is closed", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => {
      try {
        return {
          ok: true as const,
          value: await task(client),
          refresh: { ok: false as const, error: "cancelled setup refresh failed" },
        };
      } catch (error) {
        return {
          ok: false as const,
          reason: "unavailable" as const,
          error: (error as Error).message,
        };
      }
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    let nextCalls = 0;
    request.mockImplementation(
      async (method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "openclaw.setup.auth.start") {
          return { sessionId: "auth-session", done: false, status: "running" };
        }
        if (method === "wizard.next") {
          return nextCalls++ === 0
            ? {
                done: false,
                status: "running",
                step: {
                  id: "authorize",
                  type: "progress",
                  executor: "gateway",
                  message: "Waiting",
                },
              }
            : new Promise((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
                  once: true,
                });
              });
        }
        if (method === "openclaw.setup.detect") {
          return detection;
        }
        return {};
      },
    );
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(nextCalls).toBe(2));
    const queued = runExternalMutation.mock.results[0]?.value as Promise<unknown>;
    const owner = page as unknown as {
      cancelWizard: () => void;
      closeWizard: () => void;
      pendingSetupRefreshWarning: string | null;
    };

    owner.cancelWizard();
    owner.closeWizard();
    await expect(queued).resolves.toMatchObject({
      ok: true,
      refresh: { ok: false, error: "cancelled setup refresh failed" },
    });

    expect(owner.pendingSetupRefreshWarning).toBeNull();
    await vi.waitFor(() => expect(page.textContent).toContain("cancelled setup refresh failed"));
    baseRuntimeConfig.dispose();
  });

  it("retains a stale committed refresh warning across queued wizard cancellations", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let finishProgress!: () => void;
    const progress = new Promise<void>((resolve) => {
      finishProgress = resolve;
    });
    let mutationQueue = Promise.resolve();
    let mutationCalls = 0;
    const runExternalMutation = vi.fn((task: (gateway: GatewayBrowserClient) => unknown) => {
      const run = async () => {
        try {
          const value = await task(client);
          return {
            ok: true as const,
            value,
            refresh:
              mutationCalls++ === 0
                ? { ok: false as const, error: "earlier committed setup refresh failed" }
                : { ok: true as const },
          };
        } catch (error) {
          return {
            ok: false as const,
            reason: "unavailable" as const,
            error: (error as Error).message,
          };
        }
      };
      const queued = mutationQueue.then(run, run);
      mutationQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    let nextCalls = 0;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        if (nextCalls++ === 0) {
          return {
            done: false,
            status: "running",
            step: { id: "authorize", type: "progress", executor: "gateway", message: "Waiting" },
          };
        }
        await progress;
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return detection;
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(nextCalls).toBe(2));
    const owner = page as unknown as {
      cancelWizard: () => void;
      closeWizard: () => void;
      staleSetupRefreshWarning: string | null;
    };

    owner.cancelWizard();
    owner.closeWizard();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
    owner.cancelWizard();
    owner.closeWizard();
    finishProgress();

    await vi.waitFor(() => {
      expect(owner.staleSetupRefreshWarning).toBe("earlier committed setup refresh failed");
      expect(page.textContent).toContain("earlier committed setup refresh failed");
      expect(page.querySelector('[role="alert"]')?.textContent).toContain(
        "earlier committed setup refresh failed",
      );
    });
    await mutationQueue;
    baseRuntimeConfig.dispose();
  });

  it("keeps replacement wizard progress in its own serialized mutation generation", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    const firstProgress = deferred<void>();
    const secondProgress = deferred<void>();
    let mutationQueue = Promise.resolve();
    const runExternalMutation = vi.fn((task: (gateway: GatewayBrowserClient) => unknown) => {
      const run = async () => {
        try {
          return {
            ok: true as const,
            value: await task(client),
            refresh: { ok: true as const },
          };
        } catch (error) {
          return {
            ok: false as const,
            reason: "unavailable" as const,
            error: (error as Error).message,
          };
        }
      };
      const queued = mutationQueue.then(run, run);
      mutationQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    });
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    let nextCalls = 0;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.auth.start") {
        return { sessionId: "auth-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        const call = nextCalls++;
        if (call === 0 || call === 2) {
          return {
            done: false,
            status: "running",
            step: { id: "authorize", type: "progress", executor: "gateway", message: "Waiting" },
          };
        }
        await (call === 1 ? firstProgress.promise : secondProgress.promise);
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return { ...detection, setupComplete: true, configuredModel: "provider/replacement" };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          authOptions: [{ id: "provider-auth", label: "Provider", kind: "oauth", featured: true }],
        },
      },
      client,
      firstRun: false,
    });
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(nextCalls).toBe(2));
    const owner = page as unknown as { cancelWizard: () => void; closeWizard: () => void };
    owner.cancelWizard();
    owner.closeWizard();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>('[data-auth-choice="provider-auth"] button')?.click();
    await vi.waitFor(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

    firstProgress.resolve();
    await vi.waitFor(() => expect(nextCalls).toBe(4));
    let competingMutationStarted = false;
    const competingMutation = runExternalMutation(async () => {
      competingMutationStarted = true;
    });
    await Promise.resolve();
    expect(competingMutationStarted).toBe(false);

    secondProgress.resolve();

    await competingMutation;
    expect(competingMutationStarted).toBe(true);
    await vi.waitFor(() => expect(page.textContent).toContain("provider/replacement"));
    baseRuntimeConfig.dispose();
  });

  it("verifies a prepared local provider model before showing success", async () => {
    const { context: baseContext, client, request } = createContext();
    const runtimeConfig = {
      runExternalMutation: vi.fn(async (task) => ({
        ok: true as const,
        value: await task(client),
        refresh: { ok: true as const },
      })),
    } as unknown as ApplicationContext["runtimeConfig"];
    const context = { ...baseContext, runtimeConfig } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [
            {
              kind: "existing-model",
              label: "Existing llama.cpp model",
              detail: "Already configured",
              modelRef: "llama-cpp/custom",
              recommended: false,
              credentials: true,
            },
            {
              kind: "provider-auto:llama-cpp",
              brandId: "llama-cpp",
              label: "llama.cpp",
              detail: "Gemma 4 E4B downloaded",
              modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
              recommended: true,
              credentials: true,
            },
          ],
        };
      }
      if (method === "openclaw.setup.activate") {
        return {
          ok: true,
          modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
          latencyMs: 731,
          lines: ["Model ready"],
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        "openclaw.setup.activate",
        {
          kind: "provider-auto:llama-cpp",
          modelRef: "llama-cpp/gemma-4-e4b-it-q4_k_m",
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("llama-cpp/gemma-4-e4b-it-q4_k_m");
      expect(page.textContent).toContain("Verified in 731 ms");
    });
  });

  it("carries a committed prepare refresh warning through model activation", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let mutationCalls = 0;
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh:
        mutationCalls++ === 0
          ? { ok: false as const, error: "prepare refresh failed" }
          : { ok: true as const },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [
            {
              kind: "provider-auto:llama-cpp",
              brandId: "llama-cpp",
              label: "llama.cpp",
              detail: "Downloaded model",
              modelRef: "llama-cpp/verified-model",
              recommended: true,
              credentials: true,
            },
          ],
        };
      }
      if (method === "openclaw.setup.activate") {
        return { ok: true, modelRef: "llama-cpp/verified-model", latencyMs: 42, lines: [] };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("llama-cpp/verified-model");
      expect(page.textContent).toContain("prepare refresh failed");
      expect(runExternalMutation).toHaveBeenCalledTimes(2);
    });
    baseRuntimeConfig.dispose();
  });

  it("retains both prepare and activation refresh warnings when activation fails", async () => {
    const {
      context: baseContext,
      client,
      request,
      runtimeConfig: baseRuntimeConfig,
    } = createContext();
    let mutationCalls = 0;
    const runExternalMutation = vi.fn(async (task: (gateway: GatewayBrowserClient) => unknown) => ({
      ok: true as const,
      value: await task(client),
      refresh: {
        ok: false as const,
        error: mutationCalls++ === 0 ? "prepare refresh failed" : "activation refresh failed",
      },
    }));
    const context = {
      ...baseContext,
      runtimeConfig: { runExternalMutation } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          candidates: [
            {
              kind: "provider-auto:llama-cpp",
              brandId: "llama-cpp",
              label: "llama.cpp",
              detail: "Downloaded model",
              modelRef: "llama-cpp/failed-model",
              recommended: true,
              credentials: true,
            },
          ],
        };
      }
      if (method === "openclaw.setup.activate") {
        return { ok: false, status: "unavailable", error: "activation rejected" };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("activation rejected");
      expect(page.textContent).toContain("prepare refresh failed");
      expect(page.textContent).toContain("activation refresh failed");
    });
    baseRuntimeConfig.dispose();
  });

  it("keeps an incomplete provider setup visible instead of claiming success", async () => {
    const { context, client, request } = createContext();
    request.mockImplementation(async (method: string) => {
      if (method === "openclaw.setup.prepare.start") {
        return { sessionId: "prepare-session", done: false, status: "running" };
      }
      if (method === "wizard.next") {
        return { done: true, status: "done" };
      }
      if (method === "openclaw.setup.detect") {
        return {
          ...detection,
          configuredModel: "llama-cpp/persisted-before-verification",
          setupComplete: true,
        };
      }
      return {};
    });
    const { page } = await mountPage(context, {
      state: { phase: "ready", result: detection },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-prepare-choice="llama-cpp"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain(
        "Local model (llama.cpp) did not expose a usable local model. Review the setup result, then retry.",
      );
    });
    expect(page.textContent).not.toContain("llama-cpp/persisted-before-verification");
    expect(page.textContent).not.toContain("Connection verified");
    expect(request).not.toHaveBeenCalledWith(
      "openclaw.setup.activate",
      expect.anything(),
      expect.anything(),
    );
  });

  it("flushes a pending config draft before one-shot activation and refreshes afterward", async () => {
    vi.useFakeTimers();
    const { context, client, request, runtimeConfig } = createContext();
    const order: string[] = [];
    let config: Record<string, unknown> = { pending: false };
    let hash = "hash-1";
    request.mockImplementation(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        order.push(method);
        return {
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
          hash,
          valid: true,
          issues: [],
        };
      }
      if (method === "config.set") {
        order.push(method);
        config = JSON.parse((params as { raw: string }).raw) as Record<string, unknown>;
        hash = "hash-2";
        return { hash };
      }
      if (method === "openclaw.setup.activate") {
        order.push(method);
        config = { ...config, configuredModel: "openai/gpt-5" };
        hash = "hash-3";
        return { ok: true, modelRef: "openai/gpt-5", latencyMs: 42, lines: [] };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    await runtimeConfig.ensureLoaded();
    order.length = 0;
    runtimeConfig.patchForm(["pending"], true);
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(order).toEqual(["config.set", "openclaw.setup.activate", "config.get"]);
    });
    expect(runtimeConfig.state.configSnapshot?.hash).toBe("hash-3");
    expect(runtimeConfig.state.configForm).toMatchObject({
      pending: true,
      configuredModel: "openai/gpt-5",
    });
    runtimeConfig.dispose();
  });

  it("does not activate a stale candidate through a replacement connection", async () => {
    const { context: baseContext, client } = createContext();
    const replacementRequest = vi.fn();
    const replacementClient = {
      request: replacementRequest,
    } as unknown as GatewayBrowserClient;
    const context = {
      ...baseContext,
      runtimeConfig: {
        runExternalMutation: vi.fn(async (task) => {
          try {
            return {
              ok: true as const,
              value: await task(replacementClient),
              refresh: { ok: true as const },
            };
          } catch (error) {
            return { ok: false as const, reason: "error" as const, error: String(error) };
          }
        }),
      } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Connection changed before model activation started.");
    });
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it("keeps a committed activation successful while surfacing a config refresh warning", async () => {
    const { context: baseContext, client } = createContext();
    const context = {
      ...baseContext,
      runtimeConfig: {
        runExternalMutation: vi.fn(async () => ({
          ok: true as const,
          value: { ok: true, modelRef: "openai/gpt-5", latencyMs: 42, lines: [] },
          refresh: { ok: false as const, error: "config.get failed after model commit" },
        })),
      } as unknown as ApplicationContext["runtimeConfig"],
    } as ApplicationContext;
    const { page } = await mountPage(context, {
      state: {
        phase: "ready",
        result: {
          ...detection,
          candidates: [
            {
              kind: "codex-cli",
              brandId: "openai",
              label: "Codex CLI",
              detail: "Signed in locally",
              modelRef: "openai/gpt-5",
              recommended: true,
              credentials: true,
            },
          ],
        },
      },
      client,
      firstRun: false,
    });

    page.querySelector<HTMLButtonElement>('[data-candidate-kind="codex-cli"] button')?.click();

    await vi.waitFor(() => {
      expect(page.textContent).toContain("Connection verified");
      expect(page.textContent).toContain("config.get failed after model commit");
    });
  });
});
