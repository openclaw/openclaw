/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
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
import { chatRunPresentation } from "./chat-run-presentation.ts";

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

function createHistoryProgressPane(
  handler?: GatewayRequestHandler,
  readHistory: () => ChatHistoryResult | Promise<ChatHistoryResult> = () => history,
) {
  const response = { card: progressCard() };
  const request = vi.fn(
    handler ??
      (async (method: string) => {
        if (method === "chat.history") {
          return readHistory();
        }
        if (method !== "progressCard.get") {
          throw new Error(`Unexpected progress-card write: ${method}`);
        }
        return { card: response.card };
      }),
  );
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
  connectPaneTestView(pane);
  flush();
  onTestFinished(() => {
    pane.disconnectedCallback();
    chatRunPresentation(state).cancelFrame();
  });
  const emitEvent = (event: string, payload: unknown) => {
    const gateway = pane.context.gateway as ApplicationContext["gateway"] & {
      emitTestEvent: (event: GatewayEventFrame) => void;
    };
    gateway.emitTestEvent({ type: "event", event, payload });
  };
  return Object.assign(response, {
    pane,
    state,
    setState: (changes: Partial<typeof state>) => Object.assign(state, changes),
    request,
    expectMethods: (...methods: string[]) =>
      expect(request.mock.calls.map(([method]) => method)).toEqual(methods),
    dismiss: () =>
      pane.chatProps?.onDismissProgressCard?.(
        expectDefined(pane.chatProps?.progressCard, "displayed progress card"),
      ),
    sessions: context.sessions,
    progress: sessionProgressCardsForGateway(context.gateway),
    emit: (card: ProgressCard) =>
      emitEvent("progressCard.changed", { sessionKey: card.sessionKey, revision: card.revision }),
    emitEvent,
  });
}

it("hides the history owner's card only in this pane without rekeying the composer", async () => {
  const f = createHistoryProgressPane();
  const { pane, state, progress, emit, request } = f;
  state.chatMessage = "Retained draft";
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
  await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(f.card));
  expect(request).toHaveBeenLastCalledWith("progressCard.get", {
    sessionKey: "agent:research:notes",
  });
  expect(state).toMatchObject({ sessionKey: "notes", chatMessage: "Retained draft" });
  expect(resolveUiConversationIdentity(state, state.sessionKey)).toEqual({ sessionKey: "notes" });

  f.card = progressCard(2);
  emit(f.card);
  await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(f.card));
  expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(2);
  f.dismiss();
  await pane.updateComplete;
  expect(pane.chatProps?.progressCard).toBeNull();
  expect(progress.get({ sessionKey: f.card.sessionKey })).toEqual(f.card);
  expect(request.mock.calls.every(([method]) => method !== "progressCard.put")).toBe(true);
  expect(state.chatMessage).toBe("Retained draft");

  f.card = progressCard(3);
  emit(f.card);
  await vi.waitFor(() => expect(progress.get({ sessionKey: f.card.sessionKey })).toEqual(f.card));
  await pane.updateComplete;
  expect(pane.chatProps?.progressCard).toBeNull();
});

it("hides progress and its loading slot without clearing saved progress, then restores updates", async () => {
  const f = createHistoryProgressPane();
  const { pane, state, emit } = f;
  state.settings = { ...state.settings, chatShowTaskProgress: false };
  await pane.updateComplete;
  expect(pane.chatProps?.progressCardInitialLoading).toBe(false);
  await loadChatHistory(state, { deferBranches: true });
  await pane.updateComplete;
  f.expectMethods("chat.history");
  expect(pane.chatProps?.progressCard).toBeNull();

  state.settings = { ...state.settings, chatShowTaskProgress: true };
  await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(f.card));

  state.settings = { ...state.settings, chatShowTaskProgress: false };
  await pane.updateComplete;
  expect(pane.chatProps).toMatchObject({ progressCard: null, progressCardInitialLoading: false });
  f.card = progressCard(2);
  emit(f.card);
  f.expectMethods("chat.history", "progressCard.get");

  state.settings = { ...state.settings, chatShowTaskProgress: true };
  await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(f.card));
  f.expectMethods("chat.history", "progressCard.get", "progressCard.get");
});

it("retires a hidden card lifetime while the document is parked without reading until reveal", async () => {
  let visibility: DocumentVisibilityState = "visible";
  const visibilityState = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  onTestFinished(() => visibilityState.mockRestore());
  const f = createHistoryProgressPane();
  const { pane, state, request, progress, emit, emitEvent } = f;
  await loadChatHistory(state, { deferBranches: true });
  await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(f.card));
  const target = { sessionKey: f.card.sessionKey };
  const lifetime = progress.getLifetime(target);
  expect(lifetime).toBeDefined();
  f.dismiss();
  await pane.updateComplete;
  expect(pane.chatProps?.progressCard).toBeNull();

  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  f.card = progressCard(2);
  emit(f.card);
  expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  await Promise.resolve();
  flush();
  expect(progress.getLifetime(target)).toBe(lifetime);
  emitEvent("sessions.changed", { sessionKey: f.card.sessionKey, reason: "reset" });
  expect(progress.getLifetime(target)).toBeUndefined();
  expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);

  f.card = progressCard(3);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(f.card));
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
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith("sessions.describe", target.request));
  await vi.waitFor(() => expect(swarmPane.swarm.hydrator?.rows).toContainEqual(session));
  expect(state.sessionKey).toBe(target.raw);
});

type ProgressPane = ReturnType<typeof createHistoryProgressPane>;
it.each([
  ["navigation", (f) => f.setState({ sessionKey: "scratch" })],
  ["reconnect", (f) => f.setState({ connectionEpoch: f.state.connectionEpoch + 1 })],
  [
    "client replacement",
    ({ pane, state, request }) => {
      state.client = { request } as unknown as GatewayBrowserClient;
      pane.context.gateway.snapshot.client = state.client;
    },
  ],
  ["disconnect", (f) => f.setState({ connected: false })],
  ["session replacement", (f) => f.setState({ currentSessionId: "replacement-notes" })],
  ["history reset", ({ state }) => resetChatHistoryProjection(state)],
  ["archive", (f) => f.setState({ selectedChatSessionArchived: true })],
] satisfies Array<[string, (fixture: ProgressPane) => void]>)(
  "retires the accepted progress identity after %s",
  async (transition, retire) => {
    const f = createHistoryProgressPane();
    const { pane, state, request, card } = f;
    await loadChatHistory(state, { deferBranches: true });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));

    retire(f);
    await pane.updateComplete;
    expect(pane.readProgressCardScope().target).toBeUndefined();
    expect(pane.chatProps?.progressCard).toEqual(
      transition === "reconnect" || transition === "disconnect" ? card : null,
    );
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  },
);

it("does not adopt a stale history reply after navigation", async () => {
  const old = createDeferred<ChatHistoryResult>();
  const request = vi.fn(() => old.promise);
  const { pane, state } = createHistoryProgressPane(request);
  const load = loadChatHistory(state, { deferBranches: true });
  state.sessionKey = "scratch";
  old.resolve(history);
  expect(await load).toBeUndefined();
  await pane.updateComplete;
  expect(pane.chatProps?.progressCard).toBeNull();
  expect(request).toHaveBeenCalledOnce();
});

it("keeps accepted progress through a same-session background history refresh", async () => {
  const refreshed = createDeferred<ChatHistoryResult>();
  let historyReads = 0;
  const f = createHistoryProgressPane(undefined, () =>
    ++historyReads === 1 ? history : refreshed.promise,
  );
  const { pane, state, request, card } = f;
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
