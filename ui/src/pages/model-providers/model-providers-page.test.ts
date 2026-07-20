/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { EMPTY_MODEL_PROVIDERS_DATA, type ModelProvidersData } from "./load.ts";
import type { ModelProvidersRouteData } from "./model-providers-page.ts";
import "./model-providers-page.ts";

type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  busy: Record<string, boolean>;
  data: ModelProvidersData | null;
  routeData: ModelProvidersRouteData | undefined;
  selectedAgentId: string;
};

function createHarness(initialScopeId: string) {
  const request = vi.fn(async (method: string) => {
    switch (method) {
      case "models.authStatus":
        return { ts: 1, providers: [] };
      case "models.list":
        return { models: [] };
      case "config.get":
        return { config: {}, hash: "hash" };
      case "usage.status":
        return { updatedAt: 1, providers: [] };
      case "sessions.usage":
        return { aggregates: { byProvider: [] } };
      default:
        return {};
    }
  });
  const snapshot: ApplicationGatewaySnapshot = {
    client: { request } as unknown as GatewayBrowserClient,
    connected: true,
    reconnecting: false,
    hello: null,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  let selectionListener: (() => void) | undefined;
  const agentSelection = {
    state: { selectedId: initialScopeId, scopeId: initialScopeId as string | null },
    set: vi.fn(),
    setScope: vi.fn(),
    subscribe(listener: () => void) {
      selectionListener = listener;
      return () => {
        selectionListener = undefined;
      };
    },
  };
  const subscribe = () => () => undefined;
  const context = {
    gateway: { snapshot, subscribe },
    agents: {
      state: {
        agentsList: {
          defaultId: "main",
          mainKey: "main",
          scope: "project",
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
        },
        agentsLoading: false,
      },
      ensureList: vi.fn(),
      subscribe,
    },
    agentSelection,
    runtimeConfig: { state: {}, subscribe },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  return {
    agentSelection,
    context,
    notifySelection: () => selectionListener?.(),
    request,
    snapshot,
  };
}

function appendPage(context: ApplicationContext) {
  const page = document.createElement(
    "openclaw-model-providers-page",
  ) as ModelProvidersPageTestElement;
  page.context = context;
  document.body.append(page);
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage agent scope", () => {
  it("reloads credential status when the agent selector changes", async () => {
    const { agentSelection, context, notifySelection, request } = createHarness("main");
    const page = appendPage(context);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "main" }),
    );

    request.mockClear();
    page.busy = { "logout:openai": true };
    agentSelection.state.scopeId = "writer";
    notifySelection();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "writer" }),
    );
    expect(page.busy).toEqual({});
  });

  it("discards stale route data when selection changes during preload", async () => {
    const { context, request, snapshot } = createHarness("writer");
    const staleData = { ...EMPTY_MODEL_PROVIDERS_DATA, updatedAt: 1 };
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = context;
    page.routeData = { data: staleData, client: snapshot.client, agentId: "main" };
    document.body.append(page);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "writer" }),
    );
    expect(page.selectedAgentId).toBe("writer");
    expect(page.data).not.toBe(staleData);
  });
});
