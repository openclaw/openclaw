import { expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { SystemAgentSetupDetectResult } from "../../../api/types.ts";
import type { ApplicationContext, ApplicationGateway } from "../../../app/context.ts";
import { createRuntimeConfigCapability } from "../../../lib/config/runtime-config-capability.ts";
import {
  createApplicationContextProvider,
  type ApplicationContextProvider,
} from "../../../test-helpers/application-context.ts";
import { waitForFast } from "../../../test-helpers/wait-for.ts";
import type { ModelSetupRouteData } from "../model-setup-page.ts";
import "../model-setup-page.ts";
import type { ModelSetupPageState } from "../state.ts";

export type TestModelSetupPage = HTMLElement & {
  routeData?: ModelSetupRouteData;
  updateComplete: Promise<boolean>;
};

export const recommendedIconUrl = "https://cdn.simpleicons.org/ollama";
export const customIconUrl = "https://cdn.example.com/acme.png";

export const detection: SystemAgentSetupDetectResult = {
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
      label: "llama.cpp",
      hint: "Install a verified llama.cpp server and run a private GGUF model managed by OpenClaw",
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

export function createContext() {
  const request = vi.fn<GatewayBrowserClient["request"]>();
  const client = {
    request: (...args: Parameters<GatewayBrowserClient["request"]>) => request(...args),
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok" as const,
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
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
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
    subscribeEvents: () => () => undefined,
  } as unknown as ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  return {
    client,
    request,
    runtimeConfig,
    snapshot,
    context: {
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
      runtimeConfig,
    } as unknown as ApplicationContext,
  };
}

export async function mountPage(
  context: ApplicationContext,
  fixture: ModelSetupRouteData & {
    state: Extract<ModelSetupPageState, { phase: "ready" }>;
    client: GatewayBrowserClient;
  },
): Promise<{ page: TestModelSetupPage; provider: ApplicationContextProvider }> {
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-model-setup-page") as TestModelSetupPage;
  vi.spyOn(fixture.client, "request").mockResolvedValueOnce(fixture.state.result);
  page.routeData = { firstRun: fixture.firstRun };
  provider.append(page);
  document.body.append(provider);
  await page.updateComplete;
  await waitForFast(() => expect(page.querySelector(".model-setup__loading")).toBeNull());
  return { page, provider };
}
