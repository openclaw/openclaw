import { vi } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { ApplicationRouter, RouteId } from "../app-routes.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type { ApplicationContext } from "./context.ts";

export function resetAppHostTestGlobals(): void {
  vi.useRealTimers();
  Reflect.deleteProperty(window, "webkit");
  document.documentElement.classList.remove(
    "openclaw-native-macos",
    "openclaw-native-nav",
    "openclaw-native-web-chrome",
  );
  vi.unstubAllGlobals();
}

export function committedRouterState(routeId: RouteId, pathname: string, data?: unknown) {
  const location = { pathname, search: "", hash: "" };
  return {
    location,
    resolvedLocation: location,
    status: "success",
    matches: [{ routeId, location, data }],
    pendingMatches: [],
    cachedMatches: [],
  } as unknown as ReturnType<ApplicationRouter["getState"]>;
}

export function createShellConfigFixture() {
  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  config.refresh = vi.fn(async () => null);
  return config;
}

export function createRosterRefreshContext(params: {
  previous: AgentsListResult;
  next: AgentsListResult;
  selectedId: string;
}) {
  const agentsState = { agentsList: params.previous };
  const selectionState = { selectedId: params.selectedId, scopeId: params.selectedId };
  const refreshList = vi.fn(
    async () => Object.assign(agentsState, { agentsList: params.next }).agentsList,
  );
  const actions = {
    refreshList,
    invalidateFiles: vi.fn(),
    invalidateIdentity: vi.fn(),
    ensureIdentity: vi.fn(async () => undefined),
    setSelection: vi.fn((agentId: string) => {
      Object.assign(selectionState, { selectedId: agentId, scopeId: agentId });
    }),
    refreshConfig: vi.fn(async () => null),
  };
  const context = {
    config: createShellConfigFixture(),
    agents: { state: agentsState, refreshList, invalidateFiles: actions.invalidateFiles },
    agentIdentity: { invalidate: actions.invalidateIdentity, ensure: actions.ensureIdentity },
    agentSelection: { state: selectionState, set: actions.setSelection },
    runtimeConfig: { state: { configFormDirty: false }, refreshDisplay: actions.refreshConfig },
  } as unknown as ApplicationContext;
  return { context, ...actions };
}
