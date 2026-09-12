/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult, ModelCatalogResult } from "../api/types.ts";
import { invalidateChatMetadataStore } from "../lib/chat/chat-metadata-cache.ts";
import { peekChatMetadata, beginChatMetadataPublication } from "../lib/chat/chat-metadata-store.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import { loadModelCatalog, peekModelCatalog } from "../lib/model-catalog-store.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  applySelectedChatAgent,
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "../pages/chat/chat-state-refresh.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import "./app-host.ts";
import type { ApplicationContext } from "./context.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";

type ChatMetadataShell = HTMLElement & {
  runtime: { context: ApplicationContext };
  handleGatewayEvent: (event: { event: string; payload: unknown }) => void;
};

afterEach(() => {
  vi.useRealTimers();
});

it.each(["config.changed", "chat.metadata.changed"])(
  "refreshes the retained pane after repair without changing conversation state (%s)",
  async (event) => {
    const model = { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" };
    let ready = false;
    const catalogRequest = vi.fn(async (): Promise<ModelCatalogResult> => ({
      models: [
        {
          ...model,
          available: ready,
          ...(ready ? {} : { unavailableReason: "missing-auth" as const }),
        },
      ],
    }));
    const request = vi.fn((method: string) =>
      method === "models.list" ? catalogRequest() : Promise.resolve({ commands: [] }),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const state = {
      client,
      connected: true,
      connectionEpoch: 1,
      sessionKey: "agent:main:current",
      chatModelCatalog: [],
      chatModelsLoading: false,
      chatModelCatalogError: null,
      chatMessages: [],
      chatQueue: [],
      chatRunId: null,
      chatMessage: "Keep this draft",
      chatError: "No route-compatible authentication source is configured",
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    const messages = state.chatMessages;
    const queue = state.chatQueue;
    const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
    shell.runtime = {
      context: {
        gateway: { snapshot: { client, phase: "connected" } },
        agents: { state: { agentsList: null }, refreshList: vi.fn(async () => null) },
        agentSelection: { state: { selectedId: "main" } },
        runtimeConfig: {
          state: { configFormDirty: false, configSnapshot: null },
          ensureLoaded: vi.fn(async () => null),
          refresh: vi.fn(async () => null),
        },
      } as unknown as ApplicationContext,
    };
    try {
      await refreshChatMetadata(state);
      expect(state.chatModelCatalog[0]?.available).toBe(false);
      const pending = createDeferred<{
        commands: never[];
        models: typeof state.chatModelCatalog;
      }>();
      catalogRequest.mockImplementationOnce(() => pending.promise);
      shell.handleGatewayEvent({ event, payload: {} });
      expect(state.chatModelCatalog[0]?.available).toBe(false);
      pending.resolve({
        commands: [],
        models: [{ ...model, available: false, unavailableReason: "auth-failed" }],
      });
      await vi.waitFor(() =>
        expect(state.chatModelCatalog[0]?.unavailableReason).toBe("auth-failed"),
      );
      catalogRequest.mockRejectedValueOnce(new Error("metadata transport failed"));
      shell.handleGatewayEvent({ event, payload: {} });
      await vi.waitFor(() =>
        expect(state.chatModelCatalogError).toContain("metadata transport failed"),
      );
      expect(state.chatModelCatalog[0]?.available).toBe(false);
      ready = true;
      shell.handleGatewayEvent({ event, payload: {} });
      await vi.waitFor(() => expect(state.chatModelCatalog[0]?.available).toBe(true));
      expect(state.chatMessage).toBe("Keep this draft");
      expect(state.chatError).toBe("No route-compatible authentication source is configured");
      expect(state.chatMessages).toBe(messages);
      expect(state.chatQueue).toBe(queue);
      expect(state.chatRunId).toBeNull();
      expect(catalogRequest.mock.calls).toHaveLength(4);
    } finally {
      retireChatMetadataRequests(state);
    }
  },
);

it("retires chat metadata through config.changed and the Gateway close callback", () => {
  vi.useFakeTimers();
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.(gatewayHelloForMethods([]));
  const client = gateway.snapshot.client;
  assert.ok(client);
  const connectionBootstrap = {
    reset: vi.fn(),
    run: (_key: string, task: () => Promise<unknown>) => task(),
    synchronize: vi.fn(),
  };
  const context = {
    gateway,
    connectionBootstrap,
    runtimeConfig: {
      state: { configFormDirty: false, configSnapshot: null },
      ensureLoaded: vi.fn(async () => null),
      refresh: vi.fn(async () => null),
    },
  } as unknown as ApplicationContext;
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = { context };

  beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [], models: [] });
  shell.handleGatewayEvent({ event: "config.changed", payload: {} });
  expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();

  beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [], models: [] });
  current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
  expect(peekChatMetadata(client, { agentId: "main" })).toBeUndefined();
  gateway.stop();
});

describe.each(["auth", "catalog"] as const)("%s read lifecycle", (kind) => {
  it.each([
    "config.changed",
    "chat.metadata.changed",
    "same-client reconnect",
    "same-client hello",
    "same-client identity",
  ])("retires shared reads through Gateway callbacks or shell events (%s)", async (transition) => {
    vi.useFakeTimers();
    const staleResult = kind === "auth" ? { ts: 1, providers: [] } : { models: [] };
    const freshResult =
      kind === "auth"
        ? { ts: 2, providers: [] }
        : { models: [{ id: "fresh", name: "Fresh", provider: "test" }] };
    const stale = createDeferred<ModelAuthStatusResult | ModelCatalogResult>();
    const fresh = createDeferred<ModelAuthStatusResult | ModelCatalogResult>();
    const { gateway, current } = createGatewayStoreTestStore();
    gateway.start();
    current().opts.onHello?.(gatewayHelloForMethods([]));
    const request = current()
      .request.mockImplementationOnce(() => stale.promise)
      .mockImplementation(() => fresh.promise);
    const client = gateway.snapshot.client;
    assert.ok(client);
    const context = {
      gateway,
      connectionBootstrap: {
        reset: vi.fn(),
        run: (_key: string, task: () => Promise<unknown>) => task(),
        synchronize: vi.fn(),
      },
      runtimeConfig: {
        state: { configFormDirty: false, configSnapshot: null },
        ensureLoaded: vi.fn(async () => null),
        refresh: vi.fn(async () => null),
      },
    } as unknown as ApplicationContext;
    const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
    shell.runtime = { context };
    const read = () =>
      kind === "auth"
        ? loadModelAuthStatus(client, { agentId: "main" })
        : loadModelCatalog(client, { agentId: "main" });
    const before = read();
    if (transition === "same-client reconnect") {
      current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
      current().opts.onHello?.(gatewayHelloForMethods([]));
    } else if (transition === "same-client hello") {
      current().opts.onHello?.(gatewayHelloForMethods([]));
    } else if (transition === "same-client identity") {
      current().opts.onEvent?.({
        type: "event",
        event: "presence",
        payload: {
          presence: [{ instanceId: current().instanceId, user: { id: "replacement" } }],
        },
      });
    } else {
      shell.handleGatewayEvent({ event: transition, payload: {} });
    }
    const replacement = read();
    stale.resolve(staleResult);
    expect(await before).toEqual(staleResult);
    const follower = read();
    fresh.resolve(freshResult);

    expect(await Promise.all([replacement, follower])).toEqual([freshResult, freshResult]);
    expect(request).toHaveBeenCalledTimes(2);
    gateway.stop();
  });
});

it("rebinds global chat metadata immediately on agent selection and follows later invalidation", async () => {
  const model = { id: "model", name: "Model", provider: "openai" };
  let ready = false;
  const request = vi.fn(async (_method: string, params?: { agentId?: string }) => ({
    commands: [],
    models: [{ ...model, available: params?.agentId === "main" && ready }],
  }));
  const client = { request } as unknown as GatewayBrowserClient;
  const state = makeChatHost({ client }) as ChatPageHost;
  state.connected = true;
  state.sessionKey = "global";
  state.assistantAgentId = "work";
  state.loadAssistantIdentity = vi.fn(async () => undefined);
  state.chatMessage = "Keep this draft";
  state.chatError = "Keep this error";
  const messages = state.chatMessages;
  try {
    await refreshChatMetadata(state);
    expect(state.chatModelCatalog[0]?.available).toBe(false);
    applySelectedChatAgent(state, "main");
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.metadata", {
        agentId: "main",
        sessionKey: "global",
      }),
    );
    ready = true;
    invalidateChatMetadataStore(client);
    await vi.waitFor(() => expect(state.chatModelCatalog[0]?.available).toBe(true));
    expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(3);
    expect(state.chatMessage).toBe("Keep this draft");
    expect(state.chatError).toBe("Keep this error");
    expect(state.chatMessages).toBe(messages);
  } finally {
    retireChatMetadataRequests(state);
  }
});

it("retires an unmounted session catalog on session changes without evicting draft choices", async () => {
  const request = vi.fn(async () => ({ models: [] }));
  const client = { request } as unknown as GatewayBrowserClient;
  const session = { agentId: "main", sessionKey: "main" };
  const otherAgent = { agentId: "writer", sessionKey: "main" };
  const draft = { agentId: "main" };
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = {
    context: {
      gateway: { snapshot: { client, phase: "connected" } },
      sessions: { state: { deletedSessions: [] } },
    } as unknown as ApplicationContext,
  };
  await Promise.all([
    loadModelCatalog(client, session),
    loadModelCatalog(client, otherAgent),
    loadModelCatalog(client, draft),
  ]);
  shell.handleGatewayEvent({
    event: "sessions.changed",
    payload: { key: "agent:main:main", agentId: "main", reason: "patch" },
  });
  expect(peekModelCatalog(client, session)).toBeUndefined();
  expect(peekModelCatalog(client, otherAgent)).toEqual({ models: [] });
  expect(peekModelCatalog(client, draft)).toEqual({ models: [] });
});
