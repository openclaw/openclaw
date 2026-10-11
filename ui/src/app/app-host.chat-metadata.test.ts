/* @vitest-environment jsdom */

import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult, ModelCatalogResult } from "../api/types.ts";
import {
  invalidateChatMetadataForSessionEvent,
  invalidateChatMetadataStore,
} from "../lib/chat/chat-metadata-cache.ts";
import { peekChatMetadata, beginChatMetadataPublication } from "../lib/chat/chat-metadata-store.ts";
import { loadModelAuthStatus } from "../lib/model-auth.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  subscribeModelCatalogChanges,
} from "../lib/model-catalog-store.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  applySelectedChatAgent,
  refreshChatMetadata,
  retireChatMetadataRequests,
} from "../pages/chat/chat-state-refresh.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import "./app-host.ts";
import { createShellConfigFixture } from "./app-host.test-support.ts";
import type { ApplicationContext } from "./context.ts";
import { createGatewayStoreTestStore } from "./gateway-store.test-support.ts";

type ChatMetadataShell = HTMLElement & {
  runtime: { context: ApplicationContext };
  handleGatewayEvent: (event: { event: string; payload?: unknown }) => void;
};

afterEach(() => {
  vi.useRealTimers();
});

it("retains model and auth reads across 50 metadata-only publications", async () => {
  vi.useFakeTimers();
  const { gateway, current } = createGatewayStoreTestStore();
  gateway.start();
  current().opts.onHello?.(gatewayHelloForMethods([]));
  const client = gateway.snapshot.client;
  assert.ok(client);
  const request = current().request.mockImplementation(async (method) =>
    method === "models.authStatus" ? { ts: Date.now(), providers: [] } : { models: [] },
  );
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = {
    context: {
      config: createShellConfigFixture(),
      gateway,
      runtimeConfig: {
        state: { configFormDirty: false },
        refresh: vi.fn(async () => null),
      },
    } as unknown as ApplicationContext,
  };
  const stopShell = gateway.subscribeEvents((event) => shell.handleGatewayEvent(event));
  const changed = vi.fn();
  const stopCatalog = subscribeModelCatalogChanges(gateway, changed);
  const read = () =>
    Promise.all([
      loadModelAuthStatus(client, { agentId: "main" }),
      loadModelCatalog(client, { agentId: "main" }),
    ]);
  try {
    await read();
    request.mockClear();
    for (let index = 0; index < 50; index++) {
      beginChatMetadataPublication(client, { agentId: "main" }).publish({ commands: [] });
      current().opts.onEvent?.({
        type: "event",
        event: "chat.metadata.changed",
        payload: { modelCatalogChanged: false, authChanged: false, commandsChanged: false },
      });
      expect(peekChatMetadata(client, { agentId: "main" })).toEqual({ commands: [] });
      await read();
    }
    expect
      .soft(request.mock.calls.filter(([method]) => method === "models.authStatus"))
      .toHaveLength(0);
    expect.soft(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(0);
    expect.soft(changed).not.toHaveBeenCalled();
    current().opts.onEvent?.({
      type: "event",
      event: "chat.metadata.changed",
      payload: { modelCatalogChanged: true, authChanged: false },
    });
    await read();
    await read();
    expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(0);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
    expect(changed).toHaveBeenCalledOnce();
    for (const event of ["config.changed", "chat.metadata.changed"]) {
      request.mockClear();
      changed.mockClear();
      current().opts.onEvent?.({ type: "event", event, payload: {} });
      await read();
      await read();
      expect(request.mock.calls.filter(([method]) => method === "models.authStatus")).toHaveLength(
        1,
      );
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
      expect(changed).toHaveBeenCalledOnce();
    }
  } finally {
    stopCatalog();
    stopShell();
    gateway.stop();
  }
});

it("refreshes a changed session projection through the catalog owner after explicit metadata", async () => {
  vi.useFakeTimers();
  const model = { id: "model", name: "Initial", provider: "example" };
  const currentModel = { ...model, name: "Current direct catalog" };
  const metadata = createDeferred<{ commands: never[]; models: (typeof model)[] }>();
  let changed = false;
  const request = createGatewayRequestMock((method) => {
    if (method === "chat.metadata") {
      return changed ? metadata.promise : Promise.resolve({ commands: [], models: [model] });
    }
    return Promise.resolve({ models: [changed ? currentModel : model] });
  });
  const client = createTestGatewayClient(request);
  const state = makeChatHost({ client }) as ChatPageHost;
  state.connected = true;
  state.sessionKey = "agent:main:projection";
  const scope = { agentId: "main", sessionKey: state.sessionKey };
  try {
    await refreshChatMetadata(state);
    changed = true;
    invalidateChatMetadataForSessionEvent(client, { ...scope, reason: "patch" }, {});
    const pending = refreshChatMetadata(state);
    await vi.advanceTimersByTimeAsync(2_500);
    metadata.resolve({ commands: [], models: [currentModel] });
    await pending;
    await vi.advanceTimersByTimeAsync(2_500);
    expect(state.chatModelCatalog).toEqual([currentModel]);
    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(2);
  } finally {
    metadata.resolve({ commands: [], models: [currentModel] });
    retireChatMetadataRequests(state);
    state.sessions.dispose();
  }
});

it.each([
  { event: "config.changed", payload: {}, clearsChoices: false },
  { event: "chat.metadata.changed", payload: { modelSelectionChanged: true }, clearsChoices: true },
])(
  "refreshes the retained pane without changing conversation state ($event, clears: $clearsChoices)",
  async ({ event, payload, clearsChoices }) => {
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
      ...makeChatHost(),
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
    const invalidateSessions = vi.spyOn(state.sessions, "invalidate").mockImplementation(() => {});
    const messages = state.chatMessages;
    const queue = state.chatQueue;
    const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
    shell.runtime = {
      context: {
        config: createShellConfigFixture(),
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
      shell.handleGatewayEvent({ event, payload });
      expect(state.chatModelCatalog[0]?.available).toBe(clearsChoices ? undefined : false);
      pending.resolve({
        commands: [],
        models: [{ ...model, available: false, unavailableReason: "auth-failed" }],
      });
      await vi.waitFor(() =>
        expect(state.chatModelCatalog[0]?.unavailableReason).toBe("auth-failed"),
      );
      catalogRequest.mockRejectedValueOnce(new Error("metadata transport failed"));
      shell.handleGatewayEvent({ event, payload });
      await vi.waitFor(() =>
        expect(state.chatModelCatalogError).toContain("metadata transport failed"),
      );
      expect(state.chatModelCatalog[0]?.available).toBe(clearsChoices ? undefined : false);
      ready = true;
      shell.handleGatewayEvent({ event, payload });
      await vi.waitFor(() => expect(state.chatModelCatalog[0]?.available).toBe(true));
      expect(state.chatMessage).toBe("Keep this draft");
      expect(state.chatError).toBe("No route-compatible authentication source is configured");
      expect(state.chatMessages).toBe(messages);
      expect(state.chatQueue).toBe(queue);
      expect(state.chatRunId).toBeNull();
      expect(catalogRequest.mock.calls).toHaveLength(4);
      expect(invalidateSessions).not.toHaveBeenCalled();
      expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toHaveLength(
        2,
      );
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
    config: createShellConfigFixture(),
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

it.each([
  { kind: "auth", transition: "same-client identity" },
  { kind: "catalog", transition: "same-client reconnect" },
  { kind: "catalog", transition: "same-client identity" },
])("retires shared $kind reads through $transition", async ({ kind, transition }) => {
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
  const hello = {
    ...gatewayHelloForMethods([]),
    snapshot: {
      presence: [{ instanceId: current().instanceId, user: { id: "original" } }],
    },
  };
  current().opts.onHello?.(hello);
  const request = current()
    .request.mockImplementationOnce(() => stale.promise)
    .mockImplementation(() => fresh.promise);
  const client = gateway.snapshot.client;
  assert.ok(client);
  const context = {
    config: createShellConfigFixture(),
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
  const before = read().catch((error: unknown) => error);
  if (transition === "same-client reconnect") {
    current().opts.onClose?.({ code: 1006, reason: "reconnect", willRetry: true });
    current().opts.onHello?.({ ...hello });
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
  if (kind === "catalog" && transition !== "chat.metadata.changed") {
    expect(await before).toHaveProperty("name", "AbortError");
  } else {
    expect(await before).toEqual(staleResult);
  }
  const follower = read();
  fresh.resolve(freshResult);

  expect(await Promise.all([replacement, follower])).toEqual([freshResult, freshResult]);
  expect(request).toHaveBeenCalledTimes(2);
  gateway.stop();
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
        includeModels: false,
      }),
    );
    await vi.waitFor(() => expect(state.chatModelsLoading).toBe(false));
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
  const otherSession = { agentId: "main", sessionKey: "agent:main:other" };
  const draft = { agentId: "main" };
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = {
    context: {
      config: createShellConfigFixture(),
      gateway: { snapshot: { client, phase: "connected" } },
      agents: { state: { agentsList: null } },
      sessions: { state: { deletedSessions: [] } },
    } as unknown as ApplicationContext,
  };
  await Promise.all([
    loadModelCatalog(client, session),
    loadModelCatalog(client, otherAgent),
    loadModelCatalog(client, otherSession),
    loadModelCatalog(client, draft),
  ]);
  shell.handleGatewayEvent({
    event: "sessions.changed",
    payload: { key: "agent:main:main", agentId: "main", reason: "patch" },
  });
  expect(peekModelCatalog(client, session)).toBeUndefined();
  expect(peekModelCatalog(client, otherAgent)).toEqual({ models: [] });
  expect(peekModelCatalog(client, otherSession)).toEqual({ models: [] });
  expect(peekModelCatalog(client, draft)).toEqual({ models: [] });
});

describe("session command metadata events", () => {
  const reason = "command-metadata";
  it.each([
    { key: "global", eventKey: "global", otherKey: "global", agentId: "work" },
    { key: "main", eventKey: "agent:work:main", otherKey: "agent:other:main", agentId: "work" },
  ])(
    "refreshes only the matching $agentId/$key scope",
    async ({ key, eventKey, otherKey, agentId }) => {
      vi.useFakeTimers();
      const request = vi.fn().mockResolvedValue({
        commands: [],
        models: [],
        sessionModelRevision: "initial-selection",
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const hello = {
        ...gatewayHelloForMethods([]),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      };
      const states = [
        { sessionKey: key, agentId },
        { sessionKey: otherKey, agentId: "other" },
        { sessionKey: "agent:work:unrelated", agentId: "work" },
      ].map((scope) => {
        const state = makeChatHost({ client }) as ChatPageHost;
        state.hello = hello;
        state.connected = true;
        state.sessionKey = scope.sessionKey;
        state.assistantAgentId = scope.agentId;
        return state;
      });
      const invalidations = states.map((state) =>
        vi.spyOn(state.sessions, "invalidate").mockImplementation(() => {}),
      );
      const selected = states[0];
      assert.ok(selected);
      const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
      shell.runtime = {
        context: {
          config: createShellConfigFixture(),
          gateway: { snapshot: { client, hello, phase: "connected" } },
          agents: { state: { agentsList: null } },
          sessions: selected.sessions,
        } as unknown as ApplicationContext,
      };
      try {
        await Promise.all(states.map((state) => refreshChatMetadata(state)));
        const before = request.mock.calls.filter(([method]) => method === "chat.metadata").length;
        const catalogsBefore = request.mock.calls.filter(
          ([method]) => method === "models.list",
        ).length;
        for (const payload of [
          { key: "agent:work:not-open", agentId: "work", reason },
          { key: eventKey, agentId, reason: "message" },
        ]) {
          shell.handleGatewayEvent({ event: "sessions.changed", payload });
          await vi.advanceTimersByTimeAsync(0);
          if (payload.key === "agent:work:not-open") {
            for (const state of states) {
              expect(
                peekModelCatalog(client, {
                  agentId: state.assistantAgentId ?? undefined,
                  sessionKey: state.sessionKey,
                })?.models,
              ).toEqual([]);
            }
          }
        }
        expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(
          before,
        );
        expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(
          catalogsBefore,
        );
        shell.handleGatewayEvent({
          event: "sessions.changed",
          payload: { key: eventKey, agentId, reason },
        });
        await vi.advanceTimersByTimeAsync(2_500);
        await vi.waitFor(() =>
          expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(
            before,
          ),
        );
        expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(
          catalogsBefore + 1,
        );
        for (const invalidate of invalidations) {
          expect(invalidate).not.toHaveBeenCalled();
        }
      } finally {
        states.forEach(retireChatMetadataRequests);
      }
    },
  );
});
