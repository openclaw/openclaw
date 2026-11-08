import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createEffect, createSignal } from "solid-js";
import { expect, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationGateway } from "../../test-helpers/application-context-fixtures.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

export function activitySettings(): ReturnType<typeof loadSettings> {
  return {
    ...loadSettings(),
    gatewayUrl: "wss://activity.example.test",
    token: "",
    sessionKey: "main",
    lastActiveSessionKey: "main",
  };
}

export type TestActivityPage = ReturnType<typeof createActivityPage>;

class UnavailableActivityCapabilities {
  router!: never;
  connectionBootstrap!: never;
  agentSelection!: never;
  settingsAgentSelection!: never;
  acquireChannels!: never;
  config!: never;
  scopeUpgrade!: never;
  sidebarAttention!: never;
  runtimeConfig!: never;
  placementStartup!: never;
  plugins!: never;
  assistantDock!: never;
  overlays!: never;
  navigation!: never;
  theme!: never;
  nativeChatDrafts!: never;
  webPush!: never;
  chatSubmissions!: never;
  chatAttachmentHandoff!: never;
}

export function createActivityContext(
  source: ApplicationContext["gateway"],
  capabilities: Pick<ApplicationContext, "sessions" | "agents" | "agentIdentity">,
  basePath = "",
): ApplicationContext {
  const context = Object.assign(new UnavailableActivityCapabilities(), {
    gateway: source,
    ...capabilities,
    basePath,
    resourceBasePath: "",
    replace: vi.fn(),
    navigate: vi.fn(),
    navigateAndWait: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    preload: vi.fn(async () => {}),
    nativeDeviceSettings: null,
    nativeNotifications: null,
  });
  // Unsupported fields are runtime markers; the proxy always throws before returning them.
  return new Proxy(context, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (Object.hasOwn(target, key) && value === undefined) {
        throw new Error(`Activity fixture does not provide ${String(key)}`);
      }
      return value;
    },
  });
}

export function createActivityPage(context: ApplicationContext, initial?: RouteLocation) {
  const [location, setLocation] = createSignal(initial);
  const mounted = mountSolid(() =>
    createComponent(ApplicationProvider, {
      value: context,
      get children() {
        const page = createActivityPageState(context);
        createEffect(location, (next) => page.setRouteLocation(next));
        return createComponent(ActivityPageView, { page });
      },
    }),
  );
  flush();
  return {
    context,
    container: mounted.container,
    dispose: mounted.unmount,
    setRouteLocation(next: RouteLocation | undefined) {
      setLocation(next);
      flush();
    },
  };
}

export function previews(page: TestActivityPage) {
  const entries = page.container.querySelectorAll(".activity-entry__preview");
  return Array.from(entries, (entry) => entry.textContent);
}

export async function expandFirst(page: TestActivityPage) {
  await waitForSolid(() => expect(page.container.querySelector(".activity-entry")).not.toBeNull());
  const row = page.container.querySelector<HTMLDetailsElement>(".activity-entry")!;
  row.open = true;
  row.dispatchEvent(new Event("toggle"));
  flush();
  return row;
}

export function toolEvent(id: string, sessionKey = "main", name = "read", runId = `run-${id}`) {
  const data = { toolCallId: id, name, phase: "result", result: { text: `${id} output` } };
  return createGatewayEvent("session.tool", { stream: "tool", runId, sessionKey, data });
}

export const activityHello = (recoveryScope = "activity-owner-a"): GatewayHelloOk => ({
  type: "hello-ok",
  protocol: 1,
  auth: { role: "operator", scopes: ["operator.read"], recoveryScope },
});

export function createActivityGatewayStub(): ApplicationContext["gateway"] {
  const snapshot = { ...createApplicationGateway().gateway.snapshot, sessionKey: "main" };
  // SAFETY: Static route tests only read the snapshot and register these observers.
  return {
    snapshot,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: vi.fn(() => () => undefined),
    subscribeEventLog: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

export function inspectorGateway(client: GatewayBrowserClient) {
  const source = createActivityGatewayStub();
  const hello = { ...activityHello(), features: { methods: ["audit.run.inspect"], events: [] } };
  Object.assign(source.snapshot, { client, phase: "connected", hello });
  return source;
}

export function activityRoster(
  sessions: GatewaySessionRow[] = [
    { key: "main", kind: "direct", hasActiveRun: true },
    { key: "agent:other:work", kind: "direct", hasActiveRun: true },
  ],
): SessionsListResult {
  const defaults = { model: null, modelProvider: null, contextTokens: null };
  return { ts: 1, path: "", count: sessions.length, sessions, defaults };
}

export const activityResponse = (method: string, params: unknown) =>
  method === "sessions.list"
    ? activityRoster()
    : method === "sessions.subscribe"
      ? { subscribed: true }
      : method === "sessions.messages.subscribe"
        ? params
        : {};

export function createActivityPageHarness() {
  const activeGateways = new Set<ApplicationContext["gateway"]>();
  const activeSessions = new Map<ApplicationContext["gateway"], ApplicationContext["sessions"]>();
  const activeAgents = new Map<ApplicationContext["gateway"], ApplicationContext["agents"]>();
  const activeIdentities = new Map<
    ApplicationContext["gateway"],
    ApplicationContext["agentIdentity"]
  >();

  function activityContext(
    source: ApplicationContext["gateway"],
    basePath = "",
  ): ApplicationContext {
    let sessions = activeSessions.get(source);
    if (!sessions) {
      sessions = createTestSessionCapability(source);
      activeSessions.set(source, sessions);
    }
    let agents = activeAgents.get(source);
    if (!agents) {
      agents = createAgentCapability(source);
      activeAgents.set(source, agents);
    }
    let agentIdentity = activeIdentities.get(source);
    if (!agentIdentity) {
      agentIdentity = createAgentIdentityCapability(source);
      activeIdentities.set(source, agentIdentity);
    }
    return createActivityContext(source, { sessions, agents, agentIdentity }, basePath);
  }

  function activityGateway() {
    const store = createGatewayStoreTestStore({
      settings: activitySettings(),
    });
    activeGateways.add(store.gateway);
    activityContext(store.gateway);
    store.gateway.start();
    store
      .current()
      .request.mockImplementation(async (method, params) => activityResponse(method, params));
    store.current().testOptions.onHello?.(activityHello());
    return store;
  }

  async function bindActivity(
    source: ApplicationContext["gateway"],
    basePath = "",
  ): Promise<TestActivityPage> {
    const page = createActivityPage(activityContext(source, basePath), {
      pathname: `${basePath}/activity`,
      search: "?view=live",
      hash: "",
    });
    await syncActivityRoster(page);
    return page;
  }

  async function syncActivityRoster(page: TestActivityPage) {
    await waitForSolid(() =>
      expect(page.container.querySelectorAll(".activity-current-work__row").length).toBeGreaterThan(
        0,
      ),
    );
  }

  async function cleanup() {
    cleanupSolid();
    for (const sessions of activeSessions.values()) {
      sessions.dispose();
    }
    for (const agents of activeAgents.values()) {
      agents.dispose();
    }
    for (const source of activeGateways) {
      source.stop();
    }
    // Credential changes start lazy cache cleanup; finish it before clearing the environment.
    await vi.dynamicImportSettled();
    activeGateways.clear();
    activeSessions.clear();
    activeAgents.clear();
    activeIdentities.clear();
    setAvatarGatewayOrigin(null);
    localStorage.clear();
    sessionStorage.clear();
  }

  return { activityContext, activityGateway, bindActivity, syncActivityRoster, cleanup };
}
