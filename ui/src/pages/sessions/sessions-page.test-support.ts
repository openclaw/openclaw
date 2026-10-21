import { createComponent, flush } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { registerListener } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import type {
  SessionCapability,
  SessionListOptions,
  SessionListSnapshot,
} from "../../lib/sessions/index.ts";
import { createSessionArchiveState } from "../../lib/sessions/session-archive-state.ts";
import {
  createSessionState,
  type SessionRefreshOptions,
  type SessionRowObservation,
} from "../../lib/sessions/session-capability.ts";
import { createSessionRowProvenance } from "../../lib/sessions/session-row-provenance.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
  createNavigationPreferencesFixture,
} from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { buildSessionsListQuery } from "./list-query.ts";
import type { SessionsRouteData } from "./route.ts";
import { createSessionsPage, type SessionsPageOwner } from "./sessions-page-state.ts";
import type { SessionsPageState } from "./sessions-page-state.types.ts";
import { SessionsPageContent } from "./sessions-page.tsx";

export type TestSessionsPage = HTMLElement &
  SessionsPageOwner["actions"] &
  ReturnType<SessionsPageOwner["view"]> & {
    readonly context: ApplicationContext;
    readonly updateComplete: Promise<boolean>;
    routeData?: SessionsRouteData;
    selectedSessions: SessionsPageState["selectedSessions"];
  };

export async function createPage(
  context: ApplicationContext,
  routeData?: SessionsRouteData,
): Promise<TestSessionsPage> {
  const host = createApplicationContextProvider(context);
  let owner!: SessionsPageOwner;
  document.body.append(host);
  const mounted = mountSolid(
    () =>
      createComponent(ApplicationProvider, {
        value: context,
        get children() {
          owner = createSessionsPage(context, routeData);
          return createComponent(SessionsPageContent, { page: owner });
        },
      }),
    { container: host },
  );
  onTestFinished(mounted.unmount);
  const page = new Proxy<HTMLElement>(host, {
    get(target, property) {
      if (property === "updateComplete") {
        return Promise.resolve().then(() => {
          flush();
          return true;
        });
      }
      if (property === "remove") {
        return () => {
          mounted.unmount();
          host.remove();
        };
      }
      if (property === "context") {
        return context;
      }
      const view = owner.view();
      if (property === "selectedSessions") {
        return new Map(
          [...view.selectedKeys].map((key) => [
            key,
            view.result?.sessions.find((row) => row.key === key) ?? { key },
          ]),
        );
      }
      if (property in owner.actions) {
        return Reflect.get(owner.actions, property);
      }
      if (property in view) {
        return Reflect.get(view, property);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "routeData") {
        owner.setRouteData(value);
        return true;
      }
      if (property === "selectedSessions") {
        owner.view().onDeselectAll();
        owner.view().onSelectPage([...value.keys()]);
        return true;
      }
      if (property === "result" || property === "error") {
        const publish = managedListPublishers.get(context.sessions);
        const query = managedPageQueries.get(context.sessions);
        if (!publish || !query) {
          throw new Error("This fixture requires a managed list publisher");
        }
        const view = owner.view();
        publish(query, {
          result: property === "result" ? value : view.result,
          error: property === "error" ? value : null,
          loading: false,
          agentId: query.agentId ?? null,
        });
        return true;
      }
      return Reflect.set(target, property, value);
    },
  }) as TestSessionsPage;
  await page.updateComplete;
  return page;
}

export function createGateway(
  client: GatewayBrowserClient = createTestGatewayClient(async () => ({ profiles: [] })),
) {
  const { gateway: source, publish, publishEvent: emitEvent } = createApplicationGateway();
  publish({
    ...source.snapshot,
    client,
    phase: "connected",
    hello: sessionMutationGatewayHello(),
    assistantAgentId: null,
    sessionKey: "main",
  });
  const setSessionKey = vi.fn();
  const gateway = {
    get snapshot() {
      return source.snapshot;
    },
    eventLog: [],
    setSessionKey,
    subscribe: source.subscribe,
    subscribeEvents: source.subscribeEvents,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  return {
    gateway,
    setSessionKey,
    emitEvent,
    emit: (patch: Partial<ApplicationGatewaySnapshot>) => publish({ ...source.snapshot, ...patch }),
  };
}

export function createSessions(overrides: Partial<SessionCapability> = {}): SessionCapability {
  return createManagedSessions(overrides).sessions;
}

function sessionListKey(options: SessionListOptions | SessionRefreshOptions): string {
  const {
    force: _force,
    backgroundHydrate: _backgroundHydrate,
    offset: _offset,
    append: _append,
    ...scope
  } = options as SessionRefreshOptions;
  return JSON.stringify(scope);
}

const managedPageQueries = new WeakMap<SessionCapability, SessionListOptions>();

const managedListPublishers = new WeakMap<
  SessionCapability,
  (options: SessionListOptions, snapshot: SessionListSnapshot) => void
>();

export function createManagedSessions(overrides: Partial<SessionCapability> = {}) {
  const subscribe = () => () => undefined;
  const archiveState = createSessionArchiveState(
    (key) => overrides.state?.result?.sessions.find((row) => row.key === key),
    () => {},
    createSessionRowProvenance(),
  );
  const snapshots = new Map<string, SessionListSnapshot>();
  const listeners = new Map<string, Set<(snapshot: SessionListSnapshot) => void>>();
  const emptySnapshot = (): SessionListSnapshot => ({
    result: null,
    agentId: null,
    loading: false,
    error: null,
  });
  const publish = (options: SessionListOptions, snapshot: SessionListSnapshot) => {
    const key = sessionListKey(options);
    snapshots.set(key, snapshot);
    listeners.get(key)?.forEach((listener) => listener(snapshot));
  };
  const listSnapshot = vi.fn(
    (options: SessionListOptions) => snapshots.get(sessionListKey(options)) ?? emptySnapshot(),
  );
  const subscribeList = vi.fn(
    (options: SessionListOptions, listener: (snapshot: SessionListSnapshot) => void) => {
      managedPageQueries.set(sessions, options);
      const key = sessionListKey(options);
      const scoped = listeners.get(key) ?? new Set();
      listeners.set(key, scoped);
      return registerListener(scoped, listener);
    },
  );
  const refreshList = vi.fn(async (options: SessionRefreshOptions = {}) => {
    const snapshot = listSnapshot(options);
    publish(options, { ...snapshot, loading: true, error: null });
    publish(options, { ...snapshot, loading: false, error: null });
  });
  const sessions = {
    state: createSessionState(),
    captureConnectionScope: () => null,
    isConnectionScopeCurrent: () => false,
    list: vi.fn(async () => null),
    listSnapshot,
    subscribeList,
    refreshList,
    observeRow: vi.fn((): SessionRowObservation => ({
      row: null,
      sessionId: null,
      hasObserved: false,
      isCurrent: () => true,
      captureReconcile: () => () => ({ status: "current", row: null }),
      dispose: () => {},
    })),
    deleteMany: vi.fn(async () => ({ deleted: [], errors: [], preservedWorktrees: [] })),
    deletionState: () => undefined,
    patch: vi.fn(async () => null),
    archiveVisibility: archiveState.visibility,
    beginArchive: archiveState.beginPending,
    create: vi.fn(async () => null),
    subscribe,
    ...overrides,
  } as unknown as SessionCapability;
  managedListPublishers.set(sessions, publish);
  return { sessions, publish, listSnapshot, subscribeList, refreshList };
}

export function createContext(
  gateway: ApplicationContext["gateway"],
  sessions: SessionCapability,
): ApplicationContext {
  const subscribe = () => () => undefined;
  return {
    basePath: "",
    gateway,
    navigation: createNavigationPreferencesFixture(),
    sessions,
    placementStartup: { pause: vi.fn() },
    agents: { state: { agentsList: null }, subscribe },
    agentIdentity: { get: () => undefined, ensure: vi.fn(), subscribe },
    agentSelection: {
      state: { selectedId: "main", scopeId: "main" },
      set: () => undefined,
      setScope: () => undefined,
      subscribe,
    },
    channels: { subscribe },
    runtimeConfig: { state: { configSnapshot: null }, subscribe },
    plugins: {
      registrations: vi.fn(() => []),
      reportError: vi.fn(),
      subscribe,
    },
    navigate: vi.fn(),
    preload: vi.fn(),
  } as unknown as ApplicationContext;
}

export async function createRenderedPage(
  context: ApplicationContext,
  result: SessionsListResult,
  statusFilter: "active" | "archived" | "all" = "active",
  expandedSessionKey: string | null = null,
): Promise<TestSessionsPage> {
  const query = buildSessionsListQuery(context, {
    limit: 50,
    includeGlobal: true,
    includeUnknown: false,
    statusFilter,
    deepLinkSessionKey: expandedSessionKey,
  });
  const publish = managedListPublishers.get(context.sessions);
  if (publish) {
    publish(query, { result, agentId: query.agentId ?? null, loading: false, error: null });
  } else {
    await context.sessions.refreshList(query);
  }
  return createPage(context, { expandedSessionKey, statusFilter });
}
