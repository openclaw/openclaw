/* @vitest-environment jsdom */
import { html, nothing, render } from "lit";
import { afterEach, assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import { disposeQuestionPromptState } from "../../app/question-prompt.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { ChatPane } from "./chat-pane-render.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import { refreshChatMetadata, retireChatMetadataRequests } from "./chat-state-refresh.ts";
import { renderChat, type ChatProps } from "./chat-view.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const defaults = { modelProvider: null, model: null, contextTokens: null };

afterEach(async () => {
  await resetComposerFixture();
});

function createRecoveringComposer(draft: string) {
  let recoveryReady = false;
  const client = createGatewayBrowserClientFixture();
  Object.defineProperty(client, "recoveryScopeReady", { get: () => recoveryReady });
  const { pane, state, context } = createRefreshChatPane(client);
  context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
  state.chatLoading = true;
  state.currentSessionId = null;
  state.chatMessage = draft;
  state.handleSendChat = vi.fn();
  const container = document.createElement("div");
  const draw = () => {
    pane.render();
    assert(pane.chatProps);
    render(renderChatComposer(pane.chatProps), container);
    const input = container.querySelector<HTMLTextAreaElement>("textarea");
    const send = container.querySelector<HTMLButtonElement>(".chat-send-btn--send");
    assert(input);
    assert(send);
    return { input, send, props: pane.chatProps };
  };
  return {
    pane,
    state,
    context,
    container,
    draw,
    finishRecovery: () => {
      recoveryReady = true;
    },
  };
}

class SuggestionRecoveryPane extends ChatPane {
  chatProps: ChatProps | undefined;

  initialize({ state, context }: ReturnType<typeof createRefreshChatPane>) {
    this.state = state;
    this.context = context;
    this.connectedClient = state.client;
    Object.defineProperty(this, "isConnected", { value: true });
    this.presencePayload = {
      presence: [
        { user: { id: "owner" }, ts: 1 },
        { user: { id: "viewer" }, ts: 1 },
      ],
    };
    onTestFinished(() => disposeQuestionPromptState(this.questionPromptState));
  }

  protected override renderChatPaneLayout({ chatProps }: { chatProps: ChatProps }) {
    this.chatProps = chatProps;
    return html``;
  }
}
customElements.define("openclaw-suggestion-recovery-test", SuggestionRecoveryPane);

it.each([
  { draft: "Keep this draft", control: false },
  { draft: "/stop", control: true },
  { draft: "/approve approval-123 allow-once", control: true },
])(
  "holds early input until recovery is ready, preserving live controls: $draft",
  ({ draft, control }) => {
    const { state, container, draw, finishRecovery } = createRecoveringComposer(draft);
    try {
      const held = draw();
      expect(held.input.disabled).toBe(false);
      expect(held.input.value).toBe(draft);
      expect(held.send.disabled).toBe(!control);
      if (!control) {
        expect(held.send.getAttribute("aria-label")).toBe(
          "Finishing connection recovery. Try sending again when it is ready.",
        );
        expect(held.send.getAttribute("aria-busy")).toBe("true");
        held.send.click();
        held.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        void held.props.onSend();
        expect(state.handleSendChat).not.toHaveBeenCalled();
        expect(held.input.value).toBe(draft);
      } else {
        held.send.click();
        expect(state.handleSendChat).toHaveBeenCalledOnce();
      }

      finishRecovery();
      const ready = draw();
      expect(state.chatLoading).toBe(true);
      expect(ready.input.value).toBe(draft);
      expect(ready.send.disabled).toBe(false);
      expect(ready.send.getAttribute("aria-busy")).toBe("false");
      ready.send.click();
      expect(state.handleSendChat).toHaveBeenCalledTimes(control ? 2 : 1);
    } finally {
      render(nothing, container);
    }
  },
);

it("keeps ordinary input usable while the initial placement turn is pending", () => {
  const { state, context, container, draw, finishRecovery } =
    createRecoveringComposer("Queue this follow-up");
  finishRecovery();
  state.hasPendingInitialTurn = () => true;
  vi.spyOn(context.placementStartup, "get").mockReturnValue({
    sessionKey: state.sessionKey,
    phase: "provisioning",
    startedAt: 1,
  });
  try {
    const { input, send } = draw();
    expect(input.disabled).toBe(false);
    expect(send.disabled).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  } finally {
    render(nothing, container);
  }
});

it("updates held Send when an edited draft changes between control and ordinary input", () => {
  const { state, container, draw } = createRecoveringComposer("/stop");
  let renderRequested = false;
  state.requestUpdate = () => {
    renderRequested = true;
  };
  let view = draw();
  const edit = (draft: string) => {
    renderRequested = false;
    view.input.value = draft;
    view.input.dispatchEvent(new Event("input", { bubbles: true }));
    // Exercise the draft-only fast path instead of unconditionally redrawing the pane.
    if (renderRequested) {
      view = draw();
    }
  };
  try {
    expect(view.send.disabled).toBe(false);
    edit("Keep this ordinary draft");
    expect(view.input.value).toBe("Keep this ordinary draft");
    expect(view.send.disabled).toBe(true);
    view.send.click();
    view.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(state.handleSendChat).not.toHaveBeenCalled();

    edit("/approve approval-123 allow-once");
    expect(view.send.disabled).toBe(false);
    view.send.click();
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  } finally {
    render(nothing, container);
  }
});

it.each(["Keep this suggestion", "/stop"])(
  "keeps suggestion submission independent of chat recovery: %s",
  async (draft) => {
    const fixture = createRecoveringComposer(draft);
    const { state, context, container } = fixture;
    state.sessionKey = "agent:main:suggestion-recovery";
    const pane = new SuggestionRecoveryPane();
    pane.initialize(fixture);
    const methods = context.gateway.snapshot.hello?.features?.methods;
    assert(methods);
    methods.push("session.suggestions.add", "session.suggestions.list");
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 1,
      defaults,
      sessions: [
        { key: state.sessionKey, kind: "direct", visibility: "suggest", sharingRole: "viewer" },
      ],
    };
    assert(state.client);
    try {
      pane.render();
      const props = pane.chatProps;
      assert(props);
      render(renderChatComposer(props), container);
      const send = container.querySelector<HTMLButtonElement>(".chat-send-btn--send");
      assert(send);
      expect(props.suggestionComposer).toBe(true);
      expect(send.disabled).toBe(false);
      const request = vi.spyOn(state.client, "request").mockResolvedValue({
        suggestion: {
          id: "suggestion-1",
          sessionKey: state.sessionKey,
          agentId: "main",
          author: { type: "human", id: "viewer", label: "Viewer" },
          text: draft,
          createdAt: 1,
          state: "pending",
        },
      });
      await props.onSend();
      expect(request).toHaveBeenCalledExactlyOnceWith("session.suggestions.add", {
        sessionKey: state.sessionKey,
        text: draft,
      });
      expect(state.chatMessage).toBe("");
      expect(state.handleSendChat).not.toHaveBeenCalled();
    } finally {
      render(nothing, container);
    }
  },
);

it.each([
  { reason: "Your operator role requires a sandboxed session.", scope: "operator.write" },
  { reason: null, scope: "operator.read" },
])("disables composition before a denied send ($reason, $scope)", ({ reason, scope }) => {
  const { pane, state, context } = createRefreshChatPane(
    createGatewayBrowserClientFixture({ recoveryScopeReady: true }),
  );
  context.gateway.snapshot.hello = sessionMutationGatewayHello([scope]);
  const row: GatewaySessionRow = {
    key: state.sessionKey,
    kind: "direct",
    sharingRole: "owner",
    sendDisabledReason: reason,
  };
  state.sessionsResult = { ts: 1, path: "", count: 1, defaults, sessions: [row] };
  state.chatMessage = "Keep this draft";
  state.handleSendChat = vi.fn();
  const container = document.createElement("div");
  const draw = () => {
    pane.render();
    assert(pane.chatProps);
    render(renderChatComposer(pane.chatProps), container);
  };
  try {
    draw();
    const input = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(input?.disabled).toBe(true);
    expect(input?.value).toBe("Keep this draft");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.disabled,
    ).toBe(true);
    const displayedReason = reason ?? pane.chatProps?.disabledReason;
    expect(displayedReason).toBeTruthy();
    expect(container.querySelector(".agent-chat__composer-status-text")?.textContent).toBe(
      displayedReason,
    );
    expect(input?.getAttribute("aria-describedby")).toContain("disabled-reason");
    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    void pane.chatProps?.onSend();
    expect(state.handleSendChat).not.toHaveBeenCalled();

    row.sendDisabledReason = null;
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    draw();
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this draft");
    expect(container.querySelector(".agent-chat__composer-status-text")).toBeNull();
    void pane.chatProps?.onSend();
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  } finally {
    render(nothing, container);
  }
});

it.each([
  { draft: "Hello", allowed: false, restricted: false },
  { draft: "/models", allowed: true, restricted: false },
  { draft: "Hello", allowed: false, restricted: true },
  { draft: "/models", allowed: true, restricted: true },
])(
  "admits $draft with no default (restricted: $restricted): $allowed",
  ({ draft, allowed, restricted }) => {
    const { pane, state, context } = createRefreshChatPane(
      createGatewayBrowserClientFixture({ recoveryScopeReady: true }),
    );
    state.sessionKey = "agent:main:setup";
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }],
    };
    state.handleSendChat = vi.fn();
    state.chatMessage = draft;
    state.chatModelCatalogInitialized = true;
    if (restricted) {
      state.chatModelSelectionPolicy = { restricted: true, defaultModel: null };
      state.chatModelCatalog = [];
    }
    pane.render();

    expect(pane.chatProps?.modelSetupRequired).toBe(!restricted);
    expect(pane.chatProps?.disabledReason).toBeNull();
    expect(pane.chatProps?.canSend).toBe(true);
    void pane.chatProps?.onSend();
    expect(state.handleSendChat).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (restricted) {
      assert(pane.chatProps);
      expect(pane.chatProps.modelRequiredReason).toBe(
        "No models are permitted by your administrator.",
      );
      const container = document.createElement("div");
      render(renderChatComposer(pane.chatProps), container);
      expect(container.querySelector(".agent-chat__disabled-banner-detail")?.textContent).toBe(
        "No models are permitted by your administrator.",
      );
      expect(container.querySelector(".agent-chat__disabled-banner button")).toBeNull();
      render(nothing, container);
    }
  },
);

it.each([
  { override: "example/custom", storedModel: "retired", allowed: true },
  { override: null, storedModel: "custom", allowed: false },
])(
  "uses the current model choice $override when the role has no default",
  ({ override, storedModel, allowed }) => {
    const { pane, state, context } = createRefreshChatPane(
      createGatewayBrowserClientFixture({ recoveryScopeReady: true }),
    );
    state.sessionKey = "agent:main:choice";
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main" }],
    };
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 1,
      defaults,
      sessions: [
        { key: state.sessionKey, kind: "direct", model: storedModel, modelProvider: "example" },
      ],
    };
    state.sessions.state.modelOverrides = { [state.sessionKey]: override };
    state.chatModelCatalog = [{ id: "custom", name: "Custom model", provider: "example" }];
    state.chatModelCatalogInitialized = true;
    state.chatModelSelectionPolicy = { restricted: true, defaultModel: null };
    state.chatMessage = "Hello";
    state.handleSendChat = vi.fn();
    pane.render();
    expect(pane.chatProps?.modelSetupRequired).toBe(false);
    expect(pane.chatProps?.modelRequiredReason).toBe(allowed ? undefined : "Choose a model");
    void pane.chatProps?.onSend();
    expect(state.handleSendChat).toHaveBeenCalledTimes(allowed ? 1 : 0);
  },
);

it.each([
  { restricted: false, cachedDefault: false },
  { restricted: true, cachedDefault: false },
  { restricted: false, cachedDefault: true },
  { restricted: true, cachedDefault: true },
])(
  "waits for the first catalog receipt before presenting setup or historical choices (restricted: $restricted, cached default: $cachedDefault)",
  async ({ restricted, cachedDefault }) => {
    const catalog = createDeferred<ModelCatalogResult>();
    const client = createGatewayBrowserClientFixture({
      recoveryScopeReady: true,
      request: (method) =>
        method === "models.list" ? catalog.promise : { commands: [], swarmEnabled: false },
    });
    const { pane, state, context } = createRefreshChatPane(client);
    state.sessionKey = "agent:main:first-catalog";
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main", model: cachedDefault ? { primary: "example/cached-default" } : {} }],
    };
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 1,
      defaults: cachedDefault
        ? { ...defaults, model: "cached-default", modelProvider: "example" }
        : defaults,
      sessions: [
        {
          key: state.sessionKey,
          kind: "direct",
          model: "primary-model",
          modelProvider: "example",
          modelOverrideSource: "user",
        },
      ],
    };
    const historyRow = state.sessionsResult.sessions[0];
    state.handleSendChat = vi.fn();
    const pending = refreshChatMetadata(state);
    const container = document.createElement("div");
    const draw = () => {
      pane.render();
      assert(pane.chatProps);
      render(renderChatComposer(pane.chatProps), container);
      return pane.chatProps;
    };
    try {
      const initial = draw();
      expect(state.chatModelCatalogInitialized).toBe(false);
      expect(initial.modelSetupRequired).toBe(false);
      expect(initial.modelRequiredReason).toBeUndefined();
      expect(container.querySelector(".agent-chat__disabled-banner")).toBeNull();
      expect(container.querySelector("[data-chat-model-select]")?.getAttribute("aria-busy")).toBe(
        "true",
      );
      expect(
        container.querySelector("[data-chat-model-select]")?.getAttribute("aria-label"),
      ).toContain("Loading models…");
      expect(container.textContent).not.toContain("primary-model");
      expect(container.textContent).not.toContain("cached-default");
      expect(container.querySelector("[data-chat-model-option]")).toBeNull();
      state.chatMessage = "Ordinary message";
      void draw().onSend();
      expect(state.handleSendChat).toHaveBeenCalledOnce();
      state.chatMessage = "/models";
      void draw().onSend();
      expect(state.handleSendChat).toHaveBeenCalledTimes(2);
      catalog.resolve({
        models: [],
        ...(restricted
          ? { modelSelectionPolicy: { restricted: true as const, defaultModel: null } }
          : {}),
      });
      await pending;
      const settled = draw();
      expect(state.chatModelCatalogInitialized).toBe(true);
      expect(settled.modelSetupRequired).toBe(!restricted && !cachedDefault);
      if (restricted) {
        expect(settled.modelRequiredReason).toBe("No models are permitted by your administrator.");
        expect(container.querySelector(".agent-chat__disabled-banner button")).toBeNull();
        expect(container.textContent).not.toContain("primary-model");
        expect(container.textContent).not.toContain("cached-default");
      }
      expect(state.sessionsResult.sessions[0]).toBe(historyRow);
      expect(historyRow?.model).toBe("primary-model");
      retireChatMetadataRequests(state);
      expect(state.chatModelCatalogInitialized).toBe(!restricted);
    } finally {
      catalog.resolve({ models: [] });
      await pending;
      retireChatMetadataRequests(state);
      render(nothing, container);
    }
  },
);

it("keeps catalog composition independent of local model credentials", () => {
  const { pane, state, context } = createRefreshChatPane(
    createGatewayBrowserClientFixture({ recoveryScopeReady: true }),
  );
  state.sessionKey = buildCatalogSessionKey(
    { catalogId: "fixture", hostId: "gateway:local", threadId: "thread-1" },
    "main",
  );
  context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "global",
    agents: [{ id: "main", model: { primary: "example/model" } }],
  };
  state.chatModelCatalog = [
    {
      id: "model",
      name: "Model",
      provider: "example",
      available: false,
      unavailableReason: "missing-auth",
    },
  ];
  pane.render();
  expect(pane.chatProps?.modelRequiredReason).toBeUndefined();
});

describe("subagent composer", () => {
  it("keeps a spawned persistent dashboard session editable", () => {
    const { pane, state } = createRefreshChatPane();
    state.sessionKey = "agent:main:dashboard:01234567-89ab-cdef-0123-456789abcdef";
    state.sessionsResult = {
      ts: 1,
      path: "",
      count: 1,
      defaults,
      sessions: [{ key: state.sessionKey, kind: "direct", spawnedBy: "agent:main:parent" }],
    };
    state.chatMessage = "Continue this work";
    pane.render();
    const container = document.createElement("div");
    render(renderChatComposer(pane.chatProps!), container);

    expect(container.querySelector("textarea")).not.toBeNull();
    expect(pane.chatProps?.canSend).toBe(true);
    expect(container.textContent).not.toContain("View-only subagent");
  });

  it.each([
    { name: "subagent key", key: "agent:main:subagent:reply-owner" },
    {
      name: "subagent classification",
      key: "agent:main:reply-owner",
      row: { classification: "subagent", spawnedBy: "agent:main:parent" },
    },
    { name: "archive", key: "agent:main:reply-owner", row: { archived: true } },
    {
      name: "restart recovery",
      key: "agent:main:reply-owner",
      row: { restartRecoveryStatus: "tombstoned" },
    },
  ] satisfies { name: string; key: string; row?: Partial<GatewaySessionRow> }[])(
    "keeps copy but not Reply when $name replaces the composer",
    ({ key, ...scenario }) => {
      installTranscriptDomMocks();
      const { pane, state } = createRefreshChatPane();
      state.sessionKey = key;
      state.sessionsResult = {
        ts: 1,
        path: "",
        count: "row" in scenario ? 1 : 0,
        defaults,
        sessions: "row" in scenario ? [{ key, kind: "direct", ...scenario.row }] : [],
      };
      state.chatLoading = false;
      state.chatMessages = [
        {
          role: "assistant",
          content: "The workspace review is complete.",
          timestamp: 1_000,
          __openclaw: { id: "review-result", seq: 1 },
        },
      ];
      const container = document.body.appendChild(document.createElement("div"));
      try {
        pane.render();
        render(renderChat(pane.chatProps!), container);
        expect(container.textContent).toContain("The workspace review is complete.");
        expect(container.querySelector("textarea")).toBeNull();
        expect(container.querySelector(".chat-reply-btn")).toBeNull();
        expect(container.querySelector(".chat-copy-btn")).not.toBeNull();
      } finally {
        render(nothing, container);
        pane.chatProps?.transcript.hostDisconnected();
        resetTranscriptTestDom();
      }
    },
  );

  it.each([
    { lineage: { spawnedBy: "agent:main:parent" }, parentLoaded: true },
    { lineage: { parentSessionKey: "agent:main:parent" }, parentLoaded: true },
    {
      lineage: { spawnedBy: "agent:main:controller", parentSessionKey: "agent:main:parent" },
      parentLoaded: true,
    },
    {
      lineage: {
        key: "agent:main:worker",
        classification: "subagent",
        spawnedBy: "agent:main:parent",
      },
      parentLoaded: true,
    },
    { lineage: { spawnedBy: "agent:main:missing" }, parentLoaded: false },
    { lineage: null, parentLoaded: false },
  ] satisfies { lineage: Partial<GatewaySessionRow> | null; parentLoaded: boolean }[])(
    "replaces subagent input with parent navigation for %j",
    ({ lineage, parentLoaded }) => {
      const { pane, state } = createRefreshChatPane();
      const parent: GatewaySessionRow = {
        key: "agent:main:parent",
        kind: "direct",
        label: "Investigation request",
        updatedAt: 1,
      };
      const child: GatewaySessionRow = {
        key: "agent:main:subagent:worker",
        kind: "direct",
        label: "Check onboarding",
        updatedAt: 2,
        ...lineage,
      };
      state.sessionKey = child.key;
      const sessions = lineage ? (parentLoaded ? [parent, child] : [child]) : [];
      state.sessionsResult = { ts: 2, path: "", count: sessions.length, defaults, sessions };
      state.chatMessage = "Retained draft";
      pane.onPaneSessionChange = vi.fn();
      state.handleSendChat = vi.fn();
      pane.render();
      const props = pane.chatProps!;
      const container = document.createElement("div");
      render(renderChatComposer({ ...props, canAbort: true, onAbort: vi.fn() }), container);
      expect(props.canSend).toBe(false);
      void props.onSend();
      expect(state.handleSendChat).not.toHaveBeenCalled();
      expect(container.querySelector("textarea, input[type=file]")).toBeNull();
      expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
      expect(container.querySelector('[aria-label="Stop generating"]')).toBeNull();
      const banner = container.querySelector(".agent-chat__disabled-banner");
      expect(banner?.textContent).toContain("View-only subagent");
      const navigate = banner?.querySelector<HTMLButtonElement>("button");
      expect(navigate?.disabled).toBe(lineage === null);
      if (parentLoaded) {
        expect(banner?.textContent).toContain("Investigation request");
        navigate?.click();
        expect(pane.onPaneSessionChange).toHaveBeenCalledWith(pane.paneId, parent.key);
      }
    },
  );

  it.each([true, false])(
    "keeps an ordinary nested session reply editable while connected=%s",
    (connected) => {
      installTranscriptDomMocks();
      const { pane, state } = createRefreshChatPane(
        connected ? createGatewayBrowserClientFixture() : undefined,
      );
      state.sessionKey = "agent:main:fork";
      state.sessionsResult = {
        ts: 0,
        path: "",
        count: 1,
        defaults,
        sessions: [
          {
            key: state.sessionKey,
            kind: "direct",
            updatedAt: 0,
            parentSessionKey: "agent:main:parent",
          },
        ],
      };
      state.chatLoading = false;
      state.chatModelCatalogInitialized = true;
      state.chatMessage = "Keep this draft";
      state.chatMessages = [{ role: "assistant", content: "Review complete.", timestamp: 1_000 }];
      const container = document.body.appendChild(document.createElement("div"));
      const draw = () => {
        pane.render();
        render(renderChat(pane.chatProps!), container);
      };
      try {
        draw();
        expect(pane.chatProps?.canSend).toBe(true);
        expect(container.querySelector(".agent-chat__disabled-banner")).toBeNull();
        const reply = container.querySelector<HTMLButtonElement>(".chat-reply-btn");
        expect(reply).not.toBeNull();
        reply!.click();
        draw();
        expect(container.querySelector(".chat-reply-preview__text")?.textContent).toBe(
          "Review complete.",
        );
        expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
          "Keep this draft",
        );
      } finally {
        render(nothing, container);
        pane.chatProps?.transcript.hostDisconnected();
        resetTranscriptTestDom();
      }
    },
  );
});
