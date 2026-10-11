import { vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";

export type SkillWorkshopPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  requestUpdate(): void;
};

export function createRuntimeConfigStub(options?: {
  sourceConfig?: Record<string, unknown>;
  patch?: ReturnType<typeof vi.fn>;
}) {
  return {
    state: {
      configSnapshot: options?.sourceConfig
        ? { hash: "hash-1", sourceConfig: options.sourceConfig }
        : null,
      configLoading: false,
      lastError: null as string | null,
    },
    ensureLoaded: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    patch: options?.patch ?? vi.fn(async () => true),
    subscribe: () => () => undefined,
  };
}

export function createContext(
  request: ReturnType<typeof vi.fn>,
  options?: {
    methods?: string[];
    scopes?: string[];
    runtimeConfig?: ReturnType<typeof createRuntimeConfigStub>;
    /** Route query, e.g. "?skill=deploy" from a chat notice link. */
    search?: string;
  },
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const snapshot: ApplicationGatewaySnapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: gatewayHelloForMethods(options?.methods ?? [], options?.scopes),
    assistantAgentId: "research",
    sessionKey: "global",
    lastError: null,
    lastErrorCode: null,
  };
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway: { snapshot, subscribe },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" } },
      subscribe,
    },
    agents: { state: { agentsList: null }, subscribe },
    agentSelection: { state: { selectedId: "research" }, set: vi.fn(), subscribe },
    agentIdentity: {
      get: () => ({ agentId: "research", name: "Research" }),
      subscribe,
    },
    sessions: { state: { result: null, loading: false } },
    runtimeConfig: options?.runtimeConfig ?? createRuntimeConfigStub(),
    chatSubmissions: { retain: vi.fn() },
    navigate: vi.fn(),
    router: {
      getState: () => ({
        location: { pathname: "/skills/workshop", search: options?.search ?? "" },
      }),
    },
  } as unknown as ApplicationContext;
}

/** Simulates the operator connecting the same application context to another Gateway. */
export function reconnectGateway(context: ApplicationContext, request: ReturnType<typeof vi.fn>) {
  Object.assign(context.gateway, {
    snapshot: {
      ...context.gateway.snapshot,
      client: createContext(request).gateway.snapshot.client,
    },
  });
}
