/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { sessionProgressCardsForGateway } from "../../lib/session-progress-cards.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import type { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createRenderTestChatPane,
  createSessionContext,
  connectPaneTestView,
} from "./chat-pane.test-support.ts";
import { cancelChatStreamRenderFrame } from "./chat-state-render.ts";

const history: ChatHistoryResult = {
  sessionId: "research-notes",
  sessionInfo: {
    key: "agent:research:notes",
    agentId: "research",
    sessionId: "research-notes",
    kind: "direct",
    updatedAt: 1,
  },
  messages: [{ role: "assistant", content: [{ type: "text", text: "Research transcript" }] }],
};

function progressCard(revision = 1): ProgressCard {
  return {
    sessionKey: "agent:research:notes",
    markdown: `Research progress ${revision}`,
    revision,
    updatedAt: 1_700_000_000_000 + revision,
  };
}

function createHistoryProgressPane(request: GatewayRequestHandler) {
  const client = createGatewayBrowserClientFixture({ request });
  const initial = createInitializationContext();
  const live = createSessionContext(client);
  const context: ApplicationContext = {
    ...initial,
    ...live,
    config: { ...initial.config, current: { ...initial.config.current, ...live.config.current } },
  };
  const pane = createRenderTestChatPane();
  const state = pane.initialize(context);
  const hello = gatewayHelloForMethods(["chat.history", "progressCard.get"]);
  context.gateway.snapshot.hello = hello;
  state.client = client;
  state.connected = true;
  state.hello = hello;
  state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "research" }],
  };
  context.agents.state.agentsList = state.agentsList;
  state.assistantAgentId = "main";
  pane.sessionKey = "notes";
  state.sessionKey = "notes";
  state.settings = {
    ...state.settings,
    sessionKey: "notes",
    lastActiveSessionKey: "notes",
    chatShowTaskProgress: true,
  };
  state.requestUpdate = () => pane.invalidate();
  connectPaneTestView(pane);
  flush();
  onTestFinished(() => {
    pane.disconnectedCallback();
    cancelChatStreamRenderFrame(state);
  });
  const emitEvent = (event: string, payload: unknown) => {
    const gateway = pane.context.gateway as ApplicationContext["gateway"] & {
      emitTestEvent: (event: GatewayEventFrame) => void;
    };
    gateway.emitTestEvent({ type: "event", event, payload });
  };
  return {
    pane,
    state,
    sessions: context.sessions,
    progress: sessionProgressCardsForGateway(context.gateway),
    emit: (card: ProgressCard) =>
      emitEvent("progressCard.changed", { sessionKey: card.sessionKey, revision: card.revision }),
    emitEvent,
  };
}

describe("retained bare pane progress follows accepted history ownership", () => {
  it("hides the history owner's card only in this pane without rekeying the composer", async () => {
    let card: ProgressCard = progressCard();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return history;
      }
      if (method !== "progressCard.get") {
        throw new Error(`Unexpected progress-card write: ${method}`);
      }
      return { card };
    });
    const { pane, state, progress, emit } = createHistoryProgressPane(request);
    state.chatMessage = "Retained draft";
    pane.invalidate();
    await pane.updateComplete;
    expect(request).not.toHaveBeenCalled();

    await loadChatHistory(state, { deferBranches: true });
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      {
        sessionKey: "notes",
        knownState: {},
        limit: 80,
        maxBytes: 256 * 1024,
        toolResultMaxChars: 2_000,
      },
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    expect(request).toHaveBeenLastCalledWith("progressCard.get", {
      sessionKey: "agent:research:notes",
    });
    expect(state.sessionKey).toBe("notes");
    expect(state.chatMessage).toBe("Retained draft");
    expect(resolveUiConversationIdentity(state, state.sessionKey)).toEqual({ sessionKey: "notes" });

    card = progressCard(2);
    emit(card);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(2);
    pane.chatProps?.onDismissProgressCard?.(
      expectDefined(pane.chatProps?.progressCard, "displayed progress card"),
    );
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(progress.get({ sessionKey: card.sessionKey })).toEqual(card);
    expect(request.mock.calls.every(([method]) => method !== "progressCard.put")).toBe(true);
    expect(state.chatMessage).toBe("Retained draft");

    card = progressCard(3);
    emit(card);
    await vi.waitFor(() => expect(progress.get({ sessionKey: card.sessionKey })).toEqual(card));
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
  });

  it("hides progress and its loading slot without clearing saved progress, then restores updates", async () => {
    let card = progressCard();
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? history : { card },
    );
    const { pane, state, emit } = createHistoryProgressPane(request);
    state.settings.chatShowTaskProgress = false;
    pane.invalidate();
    await pane.updateComplete;
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
    await loadChatHistory(state, { deferBranches: true });
    await pane.updateComplete;
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(pane.chatProps?.progressCard).toBeNull();

    state.settings.chatShowTaskProgress = true;
    pane.invalidate();
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));

    state.settings.chatShowTaskProgress = false;
    pane.invalidate();
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
    card = progressCard(2);
    emit(card);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "chat.history",
      "progressCard.get",
    ]);

    state.settings.chatShowTaskProgress = true;
    pane.invalidate();
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "chat.history",
      "progressCard.get",
      "progressCard.get",
    ]);
  });

  it("retires a hidden card lifetime while the document is parked without reading until reveal", async () => {
    let visibility: DocumentVisibilityState = "visible";
    const visibilityState = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    onTestFinished(() => visibilityState.mockRestore());
    let card = progressCard();
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? history : { card },
    );
    const { pane, state, progress, emit, emitEvent } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    const target = { sessionKey: card.sessionKey };
    const lifetime = progress.getLifetime(target);
    expect(lifetime).toBeDefined();
    pane.chatProps?.onDismissProgressCard?.(
      expectDefined(pane.chatProps?.progressCard, "displayed progress card"),
    );
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    card = progressCard(2);
    emit(card);
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
    await Promise.resolve();
    flush();
    expect(progress.getLifetime(target)).toBe(lifetime);
    emitEvent("sessions.changed", { sessionKey: card.sessionKey, reason: "reset" });
    expect(progress.getLifetime(target)).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);

    card = progressCard(3);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    expect(progress.getLifetime(target)).not.toBe(lifetime);
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(2);
  });

  it.each([
    { raw: "notes", canonical: "agent:research:notes", request: { key: "agent:research:notes" } },
    { raw: "unknown", canonical: "unknown", request: { key: "unknown", agentId: "research" } },
  ])("binds Swarm parent reads to accepted $raw history", async (target) => {
    const session: GatewaySessionRow = {
      ...expectDefined(history.sessionInfo, "accepted history session"),
      key: target.canonical,
      agentId: "research",
      kind: "direct",
    };
    const request = vi.fn(async (method: string) =>
      method === "chat.history"
        ? { ...history, sessionInfo: session }
        : method === "sessions.describe"
          ? { session }
          : { card: null },
    );
    const { pane, state, sessions } = createHistoryProgressPane(request);
    vi.spyOn(sessions, "canonicalListRevision", "get").mockReturnValue(1);
    vi.spyOn(sessions, "list").mockResolvedValue(
      createSessionsListResult({ omitSessionFromList: true }),
    );
    pane.sessionKey = target.raw;
    state.sessionKey = target.raw;
    state.settings = {
      ...state.settings,
      sessionKey: target.raw,
      lastActiveSessionKey: target.raw,
    };
    // SAFETY: This fixture exercises the runtime's existing protected swarm boundary.
    const swarmPane = pane as unknown as {
      refreshSwarmRoster: () => void;
      swarm: ChatPaneRuntime["swarm"];
    };
    onTestFinished(() => swarmPane.swarm.hydrator?.dispose());
    swarmPane.refreshSwarmRoster();
    expect(request).not.toHaveBeenCalled();
    await loadChatHistory(state, { deferBranches: true });
    swarmPane.refreshSwarmRoster();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", target.request),
    );
    await vi.waitFor(() => expect(swarmPane.swarm.hydrator?.rows).toContainEqual(session));
    expect(state.sessionKey).toBe(target.raw);
  });

  it.each([
    "navigation",
    "reconnect",
    "client replacement",
    "disconnect",
    "session replacement",
    "history reset",
    "archive",
  ] as const)("retires the accepted progress identity after %s", async (transition) => {
    const card = progressCard();
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? history : { card },
    );
    const { pane, state } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));

    const presented = pane.chatProps?.progressCard;
    expect(presented).toEqual(card);

    if (transition === "navigation") {
      state.sessionKey = "scratch";
    } else if (transition === "reconnect") {
      state.connectionEpoch += 1;
    } else if (transition === "client replacement") {
      state.client = { request } as unknown as GatewayBrowserClient;
      pane.context.gateway.snapshot.client = state.client;
    } else if (transition === "disconnect") {
      state.connected = false;
    } else if (transition === "session replacement") {
      state.currentSessionId = "replacement-notes";
    } else if (transition === "archive") {
      state.selectedChatSessionArchived = true;
    } else {
      resetChatHistoryProjection(state);
    }
    pane.invalidate();
    await pane.updateComplete;
    expect(pane.readProgressCardScope().target).toBeUndefined();
    expect(pane.chatProps?.progressCard).toEqual(
      transition === "reconnect" || transition === "disconnect" ? presented : null,
    );
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  });

  it("does not adopt a stale history reply after navigation", async () => {
    const old = createDeferred<ChatHistoryResult>();
    const request = vi.fn(() => old.promise);
    const { pane, state } = createHistoryProgressPane(request);
    const load = loadChatHistory(state, { deferBranches: true });
    state.sessionKey = "scratch";
    old.resolve(history);
    expect(await load).toBeUndefined();
    pane.invalidate();
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps accepted progress through a same-session background history refresh", async () => {
    const refreshed = createDeferred<ChatHistoryResult>();
    let historyReads = 0;
    const card = progressCard();
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return ++historyReads === 1 ? Promise.resolve(history) : refreshed.promise;
      }
      return Promise.resolve({ card });
    });
    const { pane, state } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));

    const refreshing = loadChatHistory(state, { deferBranches: true });
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toEqual(card);
    refreshed.resolve(history);
    await refreshing;
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toEqual(card);
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  });

  it("does not infer an existing progress owner from a missing history row", async () => {
    const request = vi.fn(async () => ({
      messages: [],
      sessionInfo: {
        key: "agent:research:notes",
        agentId: "research",
        kind: "direct",
        updatedAt: null,
      },
    }));
    const { pane, state } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
});
