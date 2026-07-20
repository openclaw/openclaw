/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import "./model-providers-page.ts";

type ModelProvidersPageTestElement = HTMLElement & {
  context: ApplicationContext;
  updateComplete: Promise<boolean>;
  busy: Record<string, boolean>;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ModelProvidersPage agent scope", () => {
  it("reloads credential status when the agent selector changes", async () => {
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
      state: { selectedId: "main", scopeId: "main" as string | null },
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
    const page = document.createElement(
      "openclaw-model-providers-page",
    ) as ModelProvidersPageTestElement;
    page.context = context;
    document.body.append(page);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "main" }),
    );

    request.mockClear();
    page.busy = { "logout:openai": true };
    agentSelection.state.scopeId = "writer";
    selectionListener?.();

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("models.authStatus", { agentId: "writer" }),
    );
    expect(page.busy).toEqual({});
  });
});
