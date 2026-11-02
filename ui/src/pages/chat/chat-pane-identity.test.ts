/* @vitest-environment jsdom */
import type { ProgressCard, ProgressCardChangedEvent } from "@openclaw/gateway-protocol";
import { createComponent, createMemo } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import { t } from "../../i18n/index.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createGatewayBrowserClientFixture,
  createInitializationContext,
  createSessionContext,
} from "./chat-application-context.test-support.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { consumePaneSessionHandoff } from "./chat-pane-shared.ts";
import {
  createRenderTestChatPane,
  createTestChatPane,
  connectPaneTestView,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { createSessionCapabilityFixture } from "./chat-session-capability.test-support.ts";
import { disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import { ChatView } from "./chat-view.tsx";
import { createComposerQuestions } from "./components/chat-composer-questions.ts";
import { questionPanelIn } from "./components/chat-question-card.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";

function createLiveSessionContext(client: GatewayBrowserClient, sessions?: SessionCapability) {
  const initial = createInitializationContext();
  const live = createSessionContext(client, sessions);
  return {
    ...initial,
    ...live,
    config: { ...initial.config, current: { ...initial.config.current, ...live.config.current } },
  };
}

function makeApproval(
  id: string,
  request: Partial<ExecApprovalRequest["request"]>,
): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: id, ...request },
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

function overlays(approvalQueue: ExecApprovalRequest[] = [], decideApproval = vi.fn()) {
  return {
    snapshot: {
      approvalQueue,
      approvalBusy: false,
      approvalCanGrant: true,
      approvalErrors: new Map(),
    },
    decideApproval,
  } as unknown as ApplicationContext["overlays"];
}

describe("chat pane assistant identity snapshots", () => {
  it("keeps live row measurements out of the admitted reservation across pane renders", () => {
    const pane = createRenderTestChatPane();
    const state = pane.initialize(createInitializationContext());
    state.currentSessionId = "row-footprint-session";
    const target = { sessionKey: state.sessionKey };
    const snapshot: ChatSessionSnapshot = {
      messages: [],
      pagination: { hasMore: false },
      sessionId: state.currentSessionId,
    };
    cacheChatSessionSnapshot(state.chatMessagesBySession, state, target, snapshot);
    pane.render();
    const row = 'row:v1:768:footer:revision-1:"video-row"';
    const layout = pane.chatProps!.widgetLayout!;
    layout.write(row, 1600);
    pane.render();
    const next = pane.chatProps!.widgetLayout!;
    expect(next.read(row)).toBeUndefined();
    next.write(row, 1100);
    expect(
      readChatSessionSnapshot(state.chatMessagesBySession, state, target)?.widgetHeights?.[row],
    ).toBe(1100);

    state.currentSessionId = "replacement-session";
    cacheChatSessionSnapshot(state.chatMessagesBySession, state, target, {
      ...snapshot,
      sessionId: state.currentSessionId,
      widgetHeights: { [row]: 400 },
    });
    pane.render();
    expect(layout.read(row)).toBeUndefined();
    expect(pane.chatProps!.widgetLayout!.read(row)).toBe(400);
  });

  it("keeps an unknown transcript loading before hello and reconciles cached or live history", () => {
    installTranscriptDomMocks();
    const pane = createRenderTestChatPane();
    const state = pane.initialize(createInitializationContext());
    state.sessionKey = "agent:main:dashboard:first-paint";
    const container = document.createElement("div");
    const draw = () => {
      pane.render();
      renderChatPropsInto(container, pane.chatProps!, pane.context);
    };
    try {
      draw();
      expect(container.querySelector(".agent-chat__empty")).toBeNull();
      expect(container.querySelector("openclaw-panel-loading-skeleton")).not.toBeNull();

      state.currentSessionId = "cached-session";
      state.chatMessages = [{ role: "assistant", content: "Cached mission briefing." }];
      draw();
      expect(container.textContent).toContain("Cached mission briefing.");
      expect(container.querySelector(".agent-chat__empty")).toBeNull();

      state.chatMessages = [];
      draw();
      expect(container.querySelector(".agent-chat__empty")?.textContent).toBe("No messages yet");

      state.currentSessionId = null;
      state.connected = true;
      state.chatLoading = true;
      draw();
      expect(container.querySelector(".agent-chat__empty")).toBeNull();

      state.chatLoading = false;
      draw();
      expect(container.querySelector(".agent-chat__empty")?.textContent).toBe("No messages yet");
    } finally {
      disposeChatView(container);
      resetTranscriptTestDom();
    }
  });

  it("rebinds agent-owned presentation when a retained fixed route changes owner", () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const retireModelOverride = vi.fn();
    const sessions = createSessionCapabilityFixture({ retireModelOverride });
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:main:main";
    state.assistantAgentId = "main";
    state.assistantName = "Main Agent";
    state.chatAvatarUrl = "https://example.test/main-avatar.png";
    state.modelAuthStatusResult = { ts: 1, providers: [] };
    state.chatModelSwitchPromises = {
      "agent:main:main": new Promise<boolean>(() => {}),
    };
    state.loadAssistantIdentity = vi.fn(async () => undefined);
    pane.sessionKey = "agent:work:main";

    (
      pane as TestChatPane & {
        willUpdate: (changedProperties: Map<PropertyKey, unknown>) => void;
      }
    ).willUpdate(new Map([["sessionKey", "agent:main:main"]]));

    expect(state).toMatchObject({
      sessionKey: "agent:work:main",
      assistantAgentId: "work",
      assistantName: "",
      chatAvatarUrl: null,
      modelAuthStatusResult: null,
    });
    expect(state.loadAssistantIdentity).toHaveBeenCalledOnce();
    expect(retireModelOverride).toHaveBeenCalledWith("agent:work:main");
  });

  it("rebinds approval delivery when the selected global agent changes", async () => {
    const request = vi.fn(
      async (
        method: string,
        params?: { key?: string; agentId?: string; initialHistory?: unknown },
      ) => {
        if (method === "sessions.messages.subscribe") {
          return {
            key: params?.key,
            agentId: params?.agentId,
            ...(params?.initialHistory
              ? { initialHistory: { ok: true, payload: { messages: [] } } }
              : {}),
          };
        }
        return method === "chat.history" || method === "chat.startup" ? { messages: [] } : {};
      },
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const context = createLiveSessionContext(client);
    Object.assign(context.agents, { ensureList: vi.fn(async () => null) });
    const { pane } = createTestChatPane({ client, sessions: context.sessions });
    pane.context = context;
    pane.connectedClient = null;
    pane.sessionKey = "global";
    pane.render = () => ({
      layout: null,
      capabilityDialogs: undefined,
      providerReviewSource: { state: pane.state, canWrite: false },
    });

    try {
      pane.connectedCallback();
      await vi.waitFor(() =>
        expect(pane.state.chatSessionMessageSubscription?.agentId).toBe("main"),
      );
      pane.state.loadAssistantIdentity = vi.fn(async () => undefined);
      context.agentSelection.set("research");
      await vi.waitFor(() => {
        expect(pane.state.chatSessionMessageSubscription?.agentId).toBe("research");
        expect(request).toHaveBeenCalledWith(
          "sessions.messages.subscribe",
          expect.objectContaining({ key: "global", agentId: "research", includeApprovals: true }),
          expect.anything(),
        );
      });
    } finally {
      pane.disconnectedCallback();
    }
  });

  it.each([
    { replace: false, bootstrapAgentId: "main", expected: "Session Agent" },
    { replace: true, bootstrapAgentId: "main", expected: "" },
    { replace: true, bootstrapAgentId: null, expected: "Gateway-wide" },
  ])(
    "resets session identity on replacement=$replace with bootstrap owner $bootstrapAgentId",
    ({ replace, bootstrapAgentId, expected }) => {
      const { pane, state } = createTestChatPane();
      const client = state.client;
      pane.context.config.current.assistantIdentity = {
        ...pane.context.config.current.assistantIdentity,
        agentId: bootstrapAgentId,
        name: "Gateway-wide",
      };
      state.assistantName = "Session Agent";
      state.assistantAvatar = "⚓";
      const nextClient = replace ? createGatewayBrowserClientFixture() : client;
      for (const phase of ["reconnecting", "connected"] as const) {
        pane.applyGatewaySnapshot({ ...pane.context.gateway.snapshot, client: nextClient, phase });
        // Only an unscoped name remains a fallback across Gateways.
        expect(state).toMatchObject({
          assistantName: expected,
          assistantAvatar: replace ? null : "⚓",
        });
      }
    },
  );
});

describe("chat pane approval requester identity", () => {
  it("renders projected approval requester titles from reactive session metadata without changing decision routing", async () => {
    const pane = createRenderTestChatPane();
    const host = {
      key: "agent:main:dashboard:host",
      kind: "direct",
      updatedAt: 1,
      label: "Host",
    } satisfies GatewaySessionRow;
    const source = {
      key: "agent:research:dashboard:source",
      kind: "direct",
      updatedAt: 1,
    } satisfies GatewaySessionRow;
    const decideApproval = vi.fn();
    const context: ApplicationContext = {
      ...createInitializationContext(createGatewayBrowserClientFixture()),
      overlays: overlays([], decideApproval),
      sessions: createSessionCapabilityFixture({
        state: {
          result: sessionsResult([host], 1),
          agentId: "main",
        },
        think: () => undefined,
        reconcile: vi.fn(),
      }),
    };
    const state = pane.initialize(context);
    state.connected = true;
    state.sessionKey = host.key;
    const now = Date.now();
    const approval: ExecApprovalRequest = {
      id: "plugin:title",
      kind: "plugin",
      sourceSessionKey: source.key,
      pluginTitle: "Review",
      request: { command: "", sessionKey: host.key, allowedDecisions: ["allow-once", "deny"] },
      createdAtMs: now,
      expiresAtMs: now + 60_000,
    };
    state.chatSessionApprovalQueue = [approval];
    Object.freeze(approval.request);
    Object.freeze(approval);
    const container = document.body.appendChild(createApplicationContextProvider(context));
    const view = mountSolid(
      () => {
        const props = createMemo(() => {
          pane.render();
          return pane.chatProps!;
        });
        return createComponent(ChatView, {
          questions: createComposerQuestions(pane.presentationId, props),
          get props() {
            return props();
          },
          application: context,
        });
      },
      { container },
    );
    try {
      for (const label of [undefined, "Source", "Renamed", undefined]) {
        Object.assign(context.sessions.state, {
          result: sessionsResult(label ? [host, { ...source, label }] : [host], now),
        });
        pane.applySessionsState(context.sessions.state);
        await waitForSolid(() => {
          const card = container.querySelector(".chat-inline-approval .exec-approval-card");
          expect(card?.getAttribute("data-approval-id")).toBe(approval.id);
          expect(card?.querySelector('[role="note"]')?.textContent?.trim()).toBe(
            t("execApproval.requestedBySession", { session: label ?? "New session" }),
          );
        });
      }
      const allow = container.querySelector<HTMLButtonElement>(".exec-approval-actions .primary")!;
      expect(allow.disabled).toBe(false);
      allow.click();
      expect(decideApproval).toHaveBeenCalledExactlyOnceWith("allow-once", approval.id, approval);
    } finally {
      chatRunPresentation(state).cancelFrame();
      view.unmount();
      pane.disconnectedCallback();
      container.remove();
    }
  });
});

function createGlobalFeaturePane(
  request: (method: string, params?: unknown) => unknown,
  methods: string[],
) {
  const client = createGatewayBrowserClientFixture({
    request: (method, params) => request(method, params),
  });
  const sessions = createSessionCapabilityFixture({
    reconcile: vi.fn(),
    think: () => undefined,
  });
  const context = createLiveSessionContext(client, sessions);
  context.gateway.snapshot.hello = gatewayHelloForMethods(methods);
  const pane = createRenderTestChatPane();
  const state = pane.initialize(context);
  Object.defineProperty(pane, "isConnected", { configurable: true, value: true });
  (pane as unknown as { connectedClient: GatewayBrowserClient }).connectedClient = client;
  state.client = client;
  state.connected = true;
  state.hello = context.gateway.snapshot.hello;
  state.agentsList = { defaultId: "main", mainKey: "main", scope: "global", agents: [] };
  context.agents.state.agentsList = state.agentsList;
  pane.sessionKey = "global";
  state.sessionKey = "global";
  const select = (agentId: string) => {
    context.agentSelection.set(agentId);
    state.assistantAgentId = agentId;
    state.currentSessionId = `${agentId}-parent`;
    setChatHistoryLoad(state, {
      phase: "committed",
      sessions: state.sessions,
      client,
      connectionEpoch: state.connectionEpoch,
      sessionKey: state.sessionKey,
      requestAgentId: agentId,
      sessionInfo: {
        key: state.sessionKey,
        sessionId: state.currentSessionId,
        agentId,
        kind: "global",
      },
    });
    state.sessionsResultAgentId = agentId;
    state.sessionsResult = sessionsResult(
      [{ key: "global", agentId, sessionId: `${agentId}-parent`, kind: "global", updatedAt: 1 }],
      1,
    );
  };
  select("research");
  connectPaneTestView(pane);
  onTestFinished(() => {
    Object.defineProperty(pane, "isConnected", { configurable: true, value: false });
    pane.disconnectedCallback();
    chatRunPresentation(state).cancelFrame();
  });
  const emit = (payload: ProgressCardChangedEvent) => {
    const gateway = context.gateway as ApplicationContext["gateway"] & {
      emitTestEvent: (event: GatewayEventFrame) => void;
    };
    gateway.emitTestEvent({ type: "event", event: "progressCard.changed", payload, seq: 1 });
  };
  return { pane, select, emit, context };
}

function globalProgressCard(agentId: string, revision = 1): ProgressCard {
  return {
    sessionKey: `agent:${agentId}:global`,
    revision,
    updatedAt: 1_700_000_000_000 + revision,
    markdown: `${agentId} progress ${revision}`,
    steps: [{ step: `${agentId} work`, status: "completed" }],
  };
}

describe("global chat pane feature ownership", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it.each([
    ["global", "research"],
    ["main", "research"],
    ["agent:research:main", undefined],
  ] as const)(
    "scopes question cards, terminal summaries and inline approvals for %s/%s",
    async (sessionKey, agentId) => {
      const { pane, select, context } = createGlobalFeaturePane(() => ({}), []);
      const now = Date.now();
      Object.assign(context, {
        overlays: {
          ...overlays([
            makeApproval("unscoped", {}),
            makeApproval("research-oldest", { sessionKey, agentId }),
            makeApproval("research-newest", { sessionKey, agentId }),
            makeApproval("other-session", { sessionKey: "agent:research:other" }),
          ]),
          subscribe: () => () => undefined,
        },
      });
      for (const [id, target] of [
        ["research-question", { sessionKey, agentId }],
        ["unscoped-question", {}],
        ["other-session-question", { sessionKey: "agent:research:other" }],
      ] as const) {
        pane.receiveQuestionEvent({
          event: "question.requested",
          payload: {
            id,
            ...target,
            createdAtMs: now,
            expiresAtMs: now + 60_000,
            status: "pending",
            questions: [{ questionId: "review", header: "Research", question: id, options: [] }],
          },
        });
      }
      const container = document.body.appendChild(createApplicationContextProvider(context));
      const draw = async () => {
        await pane.updateComplete;
        renderChatPropsInto(container, pane.chatProps!, pane.context);
        if (container.querySelector("openclaw-chat-question-card")) {
          await questionPanelIn(container);
        }
      };
      try {
        select("main");
        await draw();
        expect(pane.chatProps?.gatewayQuestionPrompts).toEqual([]);
        expect(container.querySelector(".chat-question-panel, .chat-inline-approval")).toBeNull();

        select("research");
        await draw();
        expect(pane.chatProps?.gatewayQuestionPrompts?.map((prompt) => prompt.id)).toEqual([
          "research-question",
        ]);
        expect(container.querySelector(".chat-question-panel")?.textContent).toContain(
          "research-question",
        );
        expect(
          container
            .querySelector(".chat-inline-approval [data-approval-id]")
            ?.getAttribute("data-approval-id"),
        ).toBe("research-oldest");
        pane.receiveQuestionEvent({
          event: "question.resolved",
          payload: { id: "research-question", status: "cancelled" },
        });
        await draw();
        expect(container.querySelector(".chat-question-panel")).toBeNull();
        await waitForSolid(() =>
          expect(container.querySelector(".chat-question-summary")?.textContent).toContain(
            "Skipped",
          ),
        );

        select("main");
        await draw();
        expect(container.querySelector(".chat-question-summary, .chat-inline-approval")).toBeNull();
      } finally {
        disposeChatView(container);
        container.remove();
      }
    },
  );

  it("refreshes the captured global card without chat effects and ignores stale actions", async () => {
    let revision = 1;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "progressCard.refresh") {
        return { runId: "quiet-refresh", status: "accepted", revision: 1 };
      }
      const agentId = (params as { agentId?: string } | undefined)?.agentId ?? "research";
      return { card: globalProgressCard(agentId, revision) };
    });
    const { pane, select, emit } = createGlobalFeaturePane(request, [
      "progressCard.get",
      "progressCard.refresh",
    ]);
    await vi.waitFor(() => expect(pane.chatProps?.progressCardRefresh).toBeDefined());
    const original = pane.chatProps!.progressCard!;
    const action = pane.chatProps!.progressCardRefresh!;
    const messages = pane.chatProps!.messages;
    const queue = pane.chatProps!.queue;
    action.onRefresh(original);
    expect(request).toHaveBeenLastCalledWith("progressCard.refresh", {
      sessionKey: "global",
      agentId: "research",
      idempotencyKey: expect.any(String),
    });
    await vi.waitFor(() => expect(pane.chatProps?.progressCardRefresh?.state).toBe("pending"));
    expect(pane.chatProps!.progressCard).toBe(original);
    expect(pane.chatProps!.messages).toBe(messages);
    expect(pane.chatProps!.queue).toBe(queue);
    revision = 2;
    emit({ sessionKey: "agent:research:global", revision });
    await vi.waitFor(() => expect(pane.chatProps?.progressCardRefresh?.state).toBe("updated"));
    select("main");
    action.onRefresh(original);
    await vi.waitFor(() =>
      expect(pane.chatProps?.progressCard?.sessionKey).toBe("agent:main:global"),
    );
    expect(pane.chatProps?.progressCardRefresh?.state).toBeUndefined();
    expect(request.mock.calls.filter(([method]) => method === "progressCard.refresh")).toHaveLength(
      1,
    );
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("keeps revision-checked shared clearing behind a separate writer action", async () => {
    const card = globalProgressCard("research");
    const request = vi.fn(async (method: string) =>
      method === "progressCard.put" ? { card: null } : { card },
    );
    const { pane } = createGlobalFeaturePane(request, ["progressCard.get", "progressCard.put"]);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(card));
    expect(pane.chatProps?.onClearSavedProgressCard).toBeDefined();
    pane.chatProps!.onClearSavedProgressCard!(pane.chatProps!.progressCard!);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toBeNull());
    expect(request).toHaveBeenCalledWith("progressCard.put", {
      sessionKey: "global",
      agentId: "research",
      expectedRevision: card.revision,
    });
  });

  it("keeps each hidden card hidden when the same pane switches agents", async () => {
    const research = globalProgressCard("research");
    const main = globalProgressCard("main");
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "progressCard.get") {
        throw new Error(`Unexpected progress-card write: ${method}`);
      }
      const agentId = (params as { agentId?: string } | undefined)?.agentId;
      return { card: agentId === "main" ? main : research };
    });
    const { pane, select } = createGlobalFeaturePane(request, ["progressCard.get"]);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(research));
    pane.chatProps!.onDismissProgressCard!(pane.chatProps!.progressCard!);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toBeNull());

    select("main");
    await pane.updateComplete;
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(main));
    pane.chatProps!.onDismissProgressCard!(pane.chatProps!.progressCard!);
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toBeNull());

    select("research");
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
    select("main");
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toBeNull();
    expect(request.mock.calls.every(([method]) => method === "progressCard.get")).toBe(true);
  });

  it("keeps Main progress when an old Research response arrives for the same raw global key", async () => {
    const old = createDeferred<{ card: ProgressCard }>();
    const main = globalProgressCard("main");
    let reads = 0;
    const request = vi.fn((method: string) => {
      if (method !== "progressCard.get") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return ++reads === 1 ? old.promise : Promise.resolve({ card: main });
    });
    const { pane, select, emit } = createGlobalFeaturePane(request, ["progressCard.get"]);
    await pane.updateComplete;
    expect(reads).toBe(1);
    select("main");
    await pane.updateComplete;
    expect(request).toHaveBeenLastCalledWith("progressCard.get", {
      sessionKey: "global",
      agentId: "main",
    });
    await vi.waitFor(() => expect(pane.chatProps?.progressCard).toEqual(main));
    old.resolve({ card: globalProgressCard("research") });
    await old.promise;
    await pane.updateComplete;
    emit({ sessionKey: "agent:research:global", revision: null });
    await pane.updateComplete;
    expect(pane.chatProps?.progressCard).toEqual(main);
    expect(reads).toBe(2);
  });
});

type ForkFixture = () => Promise<
  Partial<Awaited<ReturnType<SessionCapability["forkAtMessage"]>>> & { sessionKey: string }
>;

function createForkPane(forkAtMessage: ForkFixture) {
  const fixture = createTestChatPane({
    client: {} as GatewayBrowserClient,
    sessions: { forkAtMessage } as unknown as SessionCapability,
  });
  fixture.pane.sessionKey = fixture.state.sessionKey;
  onTestFinished(() => {
    fixture.pane.presented = false;
  });
  return { ...fixture, navigate: vi.fn() };
}

describe("chat pane message cuts", () => {
  it("restores forked prompt attachments into the new session composer", async () => {
    const { pane, state } = createForkPane(
      vi.fn().mockResolvedValue({
        sessionKey: "agent:main:forked",
        editorText: "edit me",
        editorAttachments: [{ mimeType: "image/png", data: "aW1hZ2U=" }],
      }),
    );
    state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];

    await pane.forkFromMessage("user-entry");

    expect(state.sessionKey).toBe("agent:main:current");
    expect(state.chatAttachments).toEqual([
      { id: "old", mimeType: "image/jpeg", dataUrl: "data:old" },
    ]);
    expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked")).toEqual({
      attachments: [
        {
          id: expect.stringMatching(/^att-/),
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        },
      ],
      draft: "edit me",
    });
  });

  it.each(["agent selection", "reconnect", "retained return"])(
    "rejects a late fork after a newer %s",
    async (change) => {
      const forked = createDeferred<{ sessionKey: string; editorText: string }>();
      const forkAtMessage = vi.fn(() => forked.promise);
      const { pane, state, navigate } = createForkPane(forkAtMessage);
      pane.onPaneSessionChange = navigate;
      state.assistantAgentId = "main";
      if (change === "agent selection") {
        state.sessionKey = "global";
      }
      const pending = pane.forkFromMessage("user-entry");
      expect(forkAtMessage).toHaveBeenCalledOnce();
      if (change === "agent selection") {
        state.assistantAgentId = "work";
      } else if (change === "reconnect") {
        state.connectionEpoch = ++pane.connectionGeneration;
      } else {
        // A -> B -> A retains A's component, session key, and connection.
        pane.presented = false;
        pane.presented = true;
      }
      state.chatMessage = "newer source draft";
      forked.resolve({ sessionKey: "agent:main:forked", editorText: "stale draft" });
      await pending;
      expect(navigate).not.toHaveBeenCalled();
      expect(consumePaneSessionHandoff(pane.context, pane.paneId, "agent:main:forked")).toBeNull();
      expect(state).toMatchObject({
        sessionKey: change === "agent selection" ? "global" : "agent:main:current",
        assistantAgentId: change === "agent selection" ? "work" : "main",
        chatMessage: "newer source draft",
      });
    },
  );

  it.each([
    { presentation: "hidden", stale: true, returnToSource: false },
    { presentation: "shown again", stale: true, returnToSource: true },
    { presentation: "shown before request", stale: false, returnToSource: true },
  ])(
    "publishes only a current fork error when $presentation",
    async ({ stale, returnToSource }) => {
      const forked = createDeferred<never>();
      const { pane, state } = createForkPane(vi.fn(() => forked.promise));
      const leaveAndReturn = () => {
        pane.presented = false;
        if (returnToSource) {
          pane.presented = true;
        }
      };
      if (!stale) {
        leaveAndReturn();
      }
      const pending = pane.forkFromMessage("user-entry");
      if (stale) {
        leaveAndReturn();
      }
      forked.reject(new Error("fork failed"));
      await pending;
      expect(state).toMatchObject({
        lastError: stale ? null : "fork failed",
        chatError: stale ? null : "fork failed",
      });
    },
  );
});
