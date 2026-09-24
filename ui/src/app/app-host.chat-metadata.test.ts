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
import { loadModelCatalog, peekModelCatalog } from "../lib/model-catalog-store.ts";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  applySelectedChatAgent,
  refreshChatMetadata,
  refreshChatModelCatalogOnDemand,
  retireChatMetadataRequests,
} from "../pages/chat/chat-state-refresh.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
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

it.each([
  { mode: "automatic", hidden: false, reject: false, replacementFails: false },
  { mode: "automatic", hidden: false, reject: true, replacementFails: false },
  { mode: "automatic", hidden: true, reject: false, replacementFails: false },
  { mode: "automatic", hidden: true, reject: true, replacementFails: false },
  { mode: "explicit", hidden: false, reject: false, replacementFails: false },
  { mode: "explicit", hidden: false, reject: false, replacementFails: true },
  { mode: "picker", hidden: false, reject: false, replacementFails: false },
  { mode: "picker", hidden: false, reject: false, replacementFails: true },
])(
  "preserves cold catalog demand across a matching session event ($mode, hidden: $hidden, rejection: $reject, replacement failure: $replacementFails)",
  async ({ mode, hidden, reject, replacementFails }) => {
    const pendingCatalog = createDeferred<ModelCatalogResult>();
    const fresh = { id: "fresh", name: "Fresh model", provider: "example" };
    let catalogReads = 0;
    const request = createGatewayRequestMock((method) => {
      if (method === "models.list") {
        if (++catalogReads === 1) {
          return pendingCatalog.promise;
        }
        return replacementFails
          ? Promise.reject(new Error("Replacement catalog failed"))
          : Promise.resolve({ models: [fresh] });
      }
      return Promise.resolve({ commands: [] });
    });
    const client = createTestGatewayClient(request);
    const state = makeChatHost({ client }) as ChatPageHost;
    state.connected = true;
    state.sessionKey = "agent:main:cold";
    let presented = true;
    state.chatMetadataIsPresented = () => presented;
    const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
    shell.runtime = {
      context: {
        gateway: { snapshot: { client, phase: "connected" } },
        agents: { state: { agentsList: null } },
        sessions: state.sessions,
      } as unknown as ApplicationContext,
    };
    const loading =
      mode === "picker"
        ? refreshChatModelCatalogOnDemand(state)
        : refreshChatMetadata(state, { automatic: mode === "automatic" });
    try {
      expect(catalogReads).toBe(1);
      shell.handleGatewayEvent({
        event: "sessions.changed",
        payload: { key: state.sessionKey, agentId: "main", reason: "message" },
      });
      presented = !hidden;
      if (reject) {
        pendingCatalog.reject(new Error("Retired catalog request failed"));
      } else {
        pendingCatalog.resolve({ models: [{ ...fresh, id: "retired" }] });
      }
      await loading;
      if (hidden) {
        expect(catalogReads).toBe(1);
        expect(state.chatModelCatalog).toEqual([]);
        presented = true;
        await refreshChatMetadata(state, { automatic: true });
      }
      expect(state.chatModelCatalog).toEqual(replacementFails ? [] : [fresh]);
      if (replacementFails) {
        expect(state.chatModelCatalogError).toContain("Replacement catalog failed");
      } else {
        expect(state.chatModelCatalogError).toBeNull();
      }
      expect(state.chatModelsLoading).toBe(false);
      expect(catalogReads).toBe(2);
      expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(
        mode === "picker" ? 0 : 1,
      );
    } finally {
      pendingCatalog.resolve({ models: [] });
      await loading;
      retireChatMetadataRequests(state);
      state.sessions.dispose();
    }
  },
);

it("keeps the pending catalog across unrelated session changes", async () => {
  const pendingCatalog = createDeferred<ModelCatalogResult>();
  const model = { id: "first", name: "First model", provider: "example" };
  const request = createGatewayRequestMock((method) =>
    method === "models.list" ? pendingCatalog.promise : Promise.resolve({ commands: [] }),
  );
  const client = createTestGatewayClient(request);
  const state = makeChatHost({ client }) as ChatPageHost;
  state.connected = true;
  state.sessionKey = "agent:main:cold";
  state.chatMessage = "Keep this draft";
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = {
    context: {
      gateway: { snapshot: { client, phase: "connected" } },
      agents: { state: { agentsList: null } },
      sessions: state.sessions,
    } as unknown as ApplicationContext,
  };
  const loading = refreshChatMetadata(state, { automatic: true });
  try {
    for (const payload of [
      { key: "agent:main:other", agentId: "main", reason: "message" },
      { key: "agent:main:other", agentId: "main", reason: "patch" },
      { key: "agent:other:cold", agentId: "other", reason: "reset" },
    ]) {
      shell.handleGatewayEvent({ event: "sessions.changed", payload });
    }
    pendingCatalog.resolve({ models: [model] });
    await loading;

    expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
    expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(1);
    expect(state.chatModelCatalog).toEqual([model]);
    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalogError).toBeNull();
    expect(state.chatMessage).toBe("Keep this draft");
  } finally {
    pendingCatalog.resolve({ models: [] });
    await loading;
    retireChatMetadataRequests(state);
    state.sessions.dispose();
  }
});

it.each(["automatic", "explicit", "remounted startup"])(
  "refreshes a changed session projection through the catalog owner after %s metadata",
  async (mode) => {
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
      if (mode === "remounted startup") {
        retireChatMetadataRequests(state);
        const startup = refreshChatMetadata(state, { automatic: true, startup: true });
        await vi.advanceTimersByTimeAsync(2_500);
        await startup;
        beginChatMetadataPublication(client, scope).publish({
          commands: [],
          models: [currentModel],
        });
      } else {
        const pending = mode === "explicit" ? refreshChatMetadata(state) : undefined;
        await vi.advanceTimersByTimeAsync(2_500);
        metadata.resolve({ commands: [], models: [currentModel] });
        await pending;
      }
      await vi.advanceTimersByTimeAsync(2_500);
      expect(state.chatModelCatalog).toEqual([currentModel]);
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(2);
    } finally {
      metadata.resolve({ commands: [], models: [currentModel] });
      retireChatMetadataRequests(state);
      state.sessions.dispose();
    }
  },
);

it.each([
  { event: "config.changed", payload: {}, clearsChoices: true },
  { event: "chat.metadata.changed", payload: { modelSelectionChanged: true }, clearsChoices: true },
  { event: "chat.metadata.changed", payload: {}, clearsChoices: false },
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
    "model selection changed",
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
    const before = read().catch((error: unknown) => error);
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
    } else if (transition === "model selection changed") {
      shell.handleGatewayEvent({
        event: "chat.metadata.changed",
        payload: { modelSelectionChanged: true },
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
  const otherSession = { agentId: "main", sessionKey: "agent:main:other" };
  const draft = { agentId: "main" };
  const shell = document.createElement("openclaw-app-shell") as unknown as ChatMetadataShell;
  shell.runtime = {
    context: {
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

describe.each(["command-metadata", "patch", "reset"])("session metadata event %s", (reason) => {
  it.each([
    {
      key: "agent:work:target",
      eventKey: "agent:work:target",
      otherKey: "agent:other:target",
      agentId: "work",
    },
    { key: "global", eventKey: "global", otherKey: "global", agentId: "work" },
    { key: "main", eventKey: "agent:main:main", otherKey: "agent:other:main", agentId: "main" },
    { key: "main", eventKey: "agent:work:main", otherKey: "agent:other:main", agentId: "work" },
  ])(
    "refreshes only the matching $agentId/$key scope",
    async ({ key, eventKey, otherKey, agentId }) => {
      vi.useFakeTimers();
      const request = vi.fn().mockResolvedValue({ commands: [], models: [] });
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
        shell.handleGatewayEvent({
          event: "sessions.changed",
          payload: { key: eventKey, agentId, reason },
        });
        await vi.advanceTimersByTimeAsync(2_500);
        await vi.waitFor(() =>
          expect(request.mock.calls.filter(([method]) => method === "chat.metadata")).toHaveLength(
            before + 1,
          ),
        );
        expect(request.mock.calls.findLast(([method]) => method === "chat.metadata")?.[1]).toEqual({
          agentId,
          sessionKey: key,
        });
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
