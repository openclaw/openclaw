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
import type { ModelSetupRouteData } from "../first-run-setup.ts";
import type { ModelSetupPageState } from "../state.ts";
import { createPage, mountModelSetupPage } from "./solid-page.test-support.tsx";
import { detected } from "./view.test-support.tsx";

export type TestModelSetupPage = ReturnType<typeof createPage>;

export const customIconUrl = "https://cdn.example.com/acme.png";

const subscribe = () => () => undefined;
const selection = () => ({ state: { selectedId: "main", scopeId: "main" }, subscribe });

export const detection: SystemAgentSetupDetectResult = {
  candidates: [],
  unavailableCandidates: [],
  manualProviders: [],
  authOptions: [],
  prepareOptions: ["ollama", "llama-cpp", "lmstudio"].map((id) => {
    const { brandId, label, hint } = detected.prepareOptions!.find((entry) => entry.id === id)!;
    return { id, brandId, label, hint };
  }),
  recommendedInstalls: detected.recommendedInstalls!.map((install) => Object.assign({}, install)),
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
    subscribe,
    subscribeEvents: subscribe,
  } as unknown as ApplicationGateway;
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  return {
    client,
    request,
    runtimeConfig,
    snapshot,
    context: {
      gateway,
      agentSelection: selection(),
      settingsAgentSelection: selection(),
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
  const page = createPage(context);
  vi.spyOn(fixture.client, "request").mockResolvedValueOnce(fixture.state.result);
  page.routeData = { firstRun: fixture.firstRun };
  provider.append(page);
  document.body.append(provider);
  mountModelSetupPage(page);
  await page.updateComplete;
  await waitForFast(() => expect(page.querySelector(".model-setup__loading")).toBeNull());
  return { page, provider };
}
