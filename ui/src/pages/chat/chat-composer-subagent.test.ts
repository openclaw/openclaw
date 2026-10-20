/* @vitest-environment jsdom */
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import { disposeQuestionPromptState } from "../../app/question-prompt.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { sessionsResult as sessions } from "../../lib/sessions/session-capability.test-support.ts";
import { sessionMutationGatewayHello as gatewayHello } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createComposerContainer,
  renderComposerInto,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { createRefreshChatPane as createPane } from "./chat-pane-history.test-support.ts";
import { ChatPaneRuntime } from "./chat-pane-render.ts";
import {
  createGatewayBrowserClientFixture as createClient,
  createPaneTestHost,
} from "./chat-pane.test-support.ts";
import { refreshChatMetadata, retireChatMetadataRequests } from "./chat-state-refresh.ts";
import { disposeChatView, renderChatPropsInto } from "./chat-view.test-helpers.ts";
import type { ChatProps } from "./chat-view.tsx";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

type Fixture = ReturnType<typeof createPane>;
type Row = Partial<GatewaySessionRow>;
const defaults = { modelProvider: null, model: null, contextTokens: null };
const restrictedReason = "No models are permitted by your administrator.";
const parentKey = "agent:main:parent";
const row = (key: string, extra: Row = {}): GatewaySessionRow => ({
  key,
  kind: "direct",
  ...extra,
});
function selectSession(state: Fixture["state"], key: string, extra: Row = {}) {
  const selected = row(key, extra);
  state.sessionKey = key;
  state.sessionsResult = sessions([selected]);
  return selected;
}
const queries =
  (root: HTMLElement) =>
  <T extends HTMLElement = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector);
function composerView(pane: Fixture["pane"]) {
  const root = createComposerContainer();
  return {
    root,
    q: queries(root),
    draw: () => {
      pane.render();
      assert(pane.chatProps);
      renderComposerInto(root, pane.chatProps);
      return pane.chatProps;
    },
  };
}
function transcriptView(client?: Parameters<typeof createPane>[0]) {
  installTranscriptDomMocks();
  const fixture = createPane(client);
  const { pane, context } = fixture;
  const root = document.body.appendChild(createComposerContainer());
  onTestFinished(() => {
    disposeChatView(root);
    resetTranscriptTestDom();
  });
  return {
    ...fixture,
    root,
    q: queries(root),
    draw: () => {
      pane.render();
      renderChatPropsInto(root, pane.chatProps!, context);
    },
  };
}
function modelPane(
  client = createClient({ recoveryScopeReady: true }),
  model?: { primary?: string },
) {
  const fixture = createPane(client);
  fixture.context.agents.state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "global",
    agents: [{ id: "main", ...(model ? { model } : {}) }],
  };
  fixture.state.handleSendChat = vi.fn();
  return fixture;
}
function recovering(draft: string) {
  let ready = false;
  const client = createClient();
  Object.defineProperty(client, "recoveryScopeReady", { get: () => ready });
  const fixture = createPane(client);
  fixture.context.gateway.snapshot.hello = gatewayHello(["operator.write"]);
  Object.assign(fixture.state, {
    chatLoading: true,
    currentSessionId: null,
    chatMessage: draft,
    handleSendChat: vi.fn(),
  });
  const view = composerView(fixture.pane);
  return {
    ...fixture,
    ...view,
    finishRecovery: () => {
      ready = true;
    },
  };
}
class SuggestionRecoveryPane extends ChatPaneRuntime {
  chatProps: ChatProps | undefined;
  initialize({ state, context }: Fixture) {
    this.state = state;
    this.context = context;
    this.connectedClient = state.client;
    Object.defineProperty(this, "isConnected", { value: true });
    this.presence.update({
      presence: ["owner", "viewer"].map((id) => ({ user: { id }, ts: 1 })),
    });
    onTestFinished(() => disposeQuestionPromptState(this.questionPromptState));
  }
  protected override renderChatPaneLayout({ chatProps }: { chatProps: ChatProps }) {
    this.chatProps = chatProps;
    return null;
  }
}
afterEach(() => resetComposerFixture());

it.each([
  { draft: "Keep this draft", control: false, cached: false },
  { draft: "/stop", control: true, cached: false },
  { draft: "Keep the cached reader in place", control: false, cached: true },
])(
  "holds early input until recovery, preserving live controls: $draft",
  ({ draft, control, cached }) => {
    const { state, q, draw, finishRecovery } = recovering(draft);
    if (cached) {
      Object.assign(state, {
        currentSessionId: "cached-session",
        chatLoading: false,
        chatMessages: [{ role: "assistant", content: "Cached reply", timestamp: 1 }],
      });
    }
    const held = draw();
    const input = q<HTMLTextAreaElement>("textarea");
    const send = q<HTMLButtonElement>(".chat-send-btn--send");
    assert(input);
    assert(send);
    expect(input).toMatchObject({ disabled: false, value: draft });
    expect(send.disabled).toBe(!control);
    expect(q(".agent-chat__composer-status")).toBeNull();
    if (!control) {
      expect(send.getAttribute("aria-label")).toBe(
        "Finishing connection recovery. Try sending again when it is ready.",
      );
      expect(send.getAttribute("aria-busy")).toBe("true");
      send.click();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      void held.onSend();
      expect(state.handleSendChat).not.toHaveBeenCalled();
      expect(input.value).toBe(draft);
    } else {
      send.click();
      expect(state.handleSendChat).toHaveBeenCalledOnce();
    }
    finishRecovery();
    draw();
    expect(state.chatLoading).toBe(!cached);
    expect(q("textarea")).toMatchObject({ value: draft });
    const ready = q<HTMLButtonElement>(".chat-send-btn--send");
    expect(ready).toMatchObject({ disabled: false });
    expect(ready?.getAttribute("aria-busy")).toBe("false");
    ready?.click();
    expect(state.handleSendChat).toHaveBeenCalledTimes(control ? 2 : 1);
  },
);

it.each([false, true])("keeps initial-turn input usable (offline=%s)", (offline) => {
  const { state, context, q, draw, finishRecovery } = recovering("Queue this follow-up");
  state.hasPendingInitialTurn = () => true;
  if (offline) {
    state.connected = false;
  } else {
    finishRecovery();
    vi.spyOn(context.placementStartup, "get").mockReturnValue({
      sessionKey: state.sessionKey,
      phase: "provisioning",
      startedAt: 1,
    });
  }
  draw();
  expect(q("textarea")).toMatchObject({ disabled: false });
  expect(q(".chat-send-btn--send")).toMatchObject({ disabled: false });
  if (offline) {
    expect(q(".agent-chat__composer-status-band")?.textContent).toBe(
      "The initial message is unresolved. Reconnect if needed, then review it before sending another message.",
    );
  } else {
    q("textarea")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(state.handleSendChat).toHaveBeenCalledOnce();
  }
});

it.each(["Keep this suggestion", "/stop"])(
  "submits suggestions independently of chat recovery: %s",
  async (draft) => {
    const fixture = recovering(draft);
    const { state, context, root, q } = fixture;
    selectSession(state, "agent:main:suggestion-recovery", {
      visibility: "suggest",
      sharingRole: "viewer",
    });
    const pane = createPaneTestHost("openclaw-suggestion-recovery-test", SuggestionRecoveryPane);
    pane.initialize(fixture);
    const methods = context.gateway.snapshot.hello?.features?.methods;
    assert(methods);
    methods.push("session.suggestions.add", "session.suggestions.list");
    assert(state.client);
    pane.render();
    const props = pane.chatProps;
    assert(props);
    renderComposerInto(root, props);
    expect(props.suggestionComposer).toBe(true);
    expect(q(".chat-send-btn--send")).toMatchObject({ disabled: false });
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
  },
);

it.each([
  { reason: "Your operator role requires a sandboxed session.", scope: "operator.write" },
  { reason: null, scope: "operator.read" },
])("disables denied sends ($reason, $scope), then recovers", ({ reason, scope }) => {
  const { pane, state, context } = createPane(createClient({ recoveryScopeReady: true }));
  context.gateway.snapshot.hello = gatewayHello([scope]);
  const selected = selectSession(state, state.sessionKey, {
    sharingRole: "owner",
    sendDisabledReason: reason,
  });
  state.chatMessage = "Keep this draft";
  state.handleSendChat = vi.fn();
  const { q, draw } = composerView(pane);
  draw();
  const input = q<HTMLTextAreaElement>("textarea");
  expect(input).toMatchObject({ disabled: true, value: "Keep this draft" });
  expect(q('button[aria-label="Send message"]')).toMatchObject({ disabled: true });
  const displayedReason = reason ?? pane.chatProps?.disabledReason;
  expect(displayedReason).toBeTruthy();
  expect(q(".agent-chat__composer-status-text")?.textContent).toBe(displayedReason);
  expect(input?.getAttribute("aria-describedby")).toContain("disabled-reason");
  input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  void pane.chatProps?.onSend();
  expect(state.handleSendChat).not.toHaveBeenCalled();
  selected.sendDisabledReason = null;
  context.gateway.snapshot.hello = gatewayHello(["operator.write"]);
  draw();
  expect(q("textarea")).toMatchObject({ disabled: false, value: "Keep this draft" });
  expect(q(".agent-chat__composer-status-text")).toBeNull();
  void pane.chatProps?.onSend();
  expect(state.handleSendChat).toHaveBeenCalledOnce();
});

it.each([
  ["Hello", false, false, undefined],
  ["Hello", false, true, undefined],
  ["/models", true, true, undefined],
  ["Hello", true, true, { override: "example/custom", stored: "retired" }],
  ["Hello", false, true, { override: null, stored: "custom" }],
] satisfies [string, boolean, boolean, { override: string | null; stored: string } | undefined][])(
  "admits %s without a role default (allowed=%s, restricted=%s)",
  (draft, allowed, restricted, choice) => {
    const { pane, state } = modelPane();
    state.sessionKey = "agent:main:setup";
    state.chatMessage = draft;
    state.chatModelCatalogInitialized = true;
    if (restricted) {
      state.chatModelSelectionPolicy = { restricted: true, defaultModel: null };
      state.chatModelCatalog = [];
    }
    if (choice) {
      selectSession(state, "agent:main:choice", { model: choice.stored, modelProvider: "example" });
      state.sessions.state.modelOverrides = { [state.sessionKey]: choice.override };
      state.chatModelCatalog = [{ id: "custom", name: "Custom model", provider: "example" }];
    }
    pane.render();
    expect(pane.chatProps?.modelSetupRequired).toBe(!restricted);
    if (!choice) {
      expect(pane.chatProps).toMatchObject({ disabledReason: null, canSend: true });
    }
    void pane.chatProps?.onSend();
    expect(state.handleSendChat).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (choice) {
      expect(pane.chatProps?.modelRequiredReason).toBe(allowed ? undefined : "Choose a model");
    } else if (restricted) {
      expect(pane.chatProps?.modelRequiredReason).toBe(restrictedReason);
      const { q, draw } = composerView(pane);
      draw();
      expect(q(".agent-chat__disabled-banner-detail")?.textContent).toBe(restrictedReason);
      expect(q(".agent-chat__disabled-banner button")).toBeNull();
    }
  },
);

it.each([
  { restricted: false, cachedDefault: false },
  { restricted: true, cachedDefault: false },
  { restricted: false, cachedDefault: true },
  { restricted: true, cachedDefault: true },
])(
  "waits for first catalog receipt (restricted=$restricted, cached=$cachedDefault)",
  async ({ restricted, cachedDefault }) => {
    const catalog = createDeferred<ModelCatalogResult>();
    const client = createClient({
      recoveryScopeReady: true,
      request: (method) =>
        method === "models.list" ? catalog.promise : { commands: [], swarmEnabled: false },
    });
    const { pane, state } = modelPane(
      client,
      cachedDefault ? { primary: "example/cached-default" } : {},
    );
    const historyRow = selectSession(state, "agent:main:first-catalog", {
      model: "primary-model",
      modelProvider: "example",
      modelOverrideSource: "user",
    });
    if (cachedDefault) {
      state.sessionsResult!.defaults = {
        ...defaults,
        model: "cached-default",
        modelProvider: "example",
      };
    }
    const pending = refreshChatMetadata(state);
    onTestFinished(async () => {
      catalog.resolve({ models: [] });
      await pending;
      retireChatMetadataRequests(state);
    });
    const { root, q, draw } = composerView(pane);
    const expectHistoryHidden = () => {
      expect(root.textContent).not.toContain("primary-model");
      expect(root.textContent).not.toContain("cached-default");
    };
    const initial = draw();
    await waitForSolid(() => expect(q("[data-chat-model-select]")).not.toBeNull());
    expect(state.chatModelCatalogInitialized).toBe(false);
    expect(initial.modelSetupRequired).toBe(false);
    expect(initial.modelRequiredReason).toBeUndefined();
    expect(q(".agent-chat__disabled-banner")).toBeNull();
    expect(q("[data-chat-model-select]")?.getAttribute("aria-busy")).toBe("true");
    expect(q("[data-chat-model-select]")?.getAttribute("aria-label")).toContain("Loading models…");
    expectHistoryHidden();
    expect(q("[data-chat-model-option]")).toBeNull();
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
      expect(settled.modelRequiredReason).toBe(restrictedReason);
      expect(q(".agent-chat__disabled-banner button")).toBeNull();
      expectHistoryHidden();
    }
    expect(state.sessionsResult!.sessions[0]).toBe(historyRow);
    expect(historyRow.model).toBe("primary-model");
    retireChatMetadataRequests(state);
    expect(state.chatModelCatalogInitialized).toBe(false);
  },
);

it("keeps catalog composition independent of local model credentials", () => {
  const { pane, state } = modelPane(undefined, { primary: "example/model" });
  state.sessionKey = buildCatalogSessionKey(
    { catalogId: "fixture", hostId: "gateway:local", threadId: "thread-1" },
    "main",
  );
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

it("keeps spawned persistent dashboard sessions editable", () => {
  const { pane, state } = createPane();
  selectSession(state, "agent:main:dashboard:01234567-89ab-cdef-0123-456789abcdef", {
    spawnedBy: parentKey,
  });
  state.chatMessage = "Continue this work";
  const { root, q, draw } = composerView(pane);
  draw();
  expect(q("textarea")).not.toBeNull();
  expect(pane.chatProps?.canSend).toBe(true);
  expect(root.textContent).not.toContain("View-only subagent");
});

it.each([
  ["subagent key", undefined],
  ["classification", { classification: "subagent", spawnedBy: parentKey }],
  ["archive", { archived: true }],
  ["restart recovery", { restartRecoveryStatus: "tombstoned" }],
] satisfies [string, Row | undefined][])("keeps Copy but not Reply for %s", (_name, override) => {
  const { state, root, q, draw } = transcriptView();
  const key = override ? "agent:main:reply-owner" : "agent:main:subagent:reply-owner";
  state.sessionKey = key;
  state.sessionsResult = sessions(override ? [row(key, override)] : []);
  state.chatLoading = false;
  state.chatMessages = [
    {
      role: "assistant",
      content: "The workspace review is complete.",
      timestamp: 1_000,
      __openclaw: { id: "review-result", seq: 1 },
    },
  ];
  draw();
  expect(root.textContent).toContain("The workspace review is complete.");
  expect(q("textarea, .chat-reply-btn")).toBeNull();
  expect(q(".chat-copy-btn")).not.toBeNull();
});

it.each([
  [{ spawnedBy: parentKey }, true],
  [{ parentSessionKey: parentKey }, true],
  [{ spawnedBy: "agent:main:controller", parentSessionKey: parentKey }, true],
  [{ key: "agent:main:worker", classification: "subagent", spawnedBy: parentKey }, true],
  [{ spawnedBy: "agent:main:missing" }, false],
  [null, false],
] satisfies [Row | null, boolean][])(
  "navigates to the subagent parent for %j",
  (lineage, parentLoaded) => {
    const { pane, state } = createPane();
    const parent = row(parentKey, { label: "Investigation request", updatedAt: 1 });
    const child = row("agent:main:subagent:worker", {
      label: "Check onboarding",
      updatedAt: 2,
      ...lineage,
    });
    state.sessionKey = child.key;
    state.sessionsResult = sessions(lineage ? (parentLoaded ? [parent, child] : [child]) : [], 2);
    state.chatMessage = "Retained draft";
    pane.onPaneSessionChange = vi.fn();
    state.handleSendChat = vi.fn();
    pane.render();
    const props = pane.chatProps!;
    const root = createComposerContainer();
    const q = queries(root);
    renderComposerInto(root, { ...props, canAbort: true, onAbort: vi.fn() });
    expect(props.canSend).toBe(false);
    void props.onSend();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(
      q('textarea, input[type=file], .agent-chat__composer-footer, [aria-label="Stop generating"]'),
    ).toBeNull();
    const banner = q(".agent-chat__disabled-banner");
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

it.each([true, false])("keeps ordinary nested replies editable (connected=%s)", (connected) => {
  const { pane, state, q, draw } = transcriptView(connected ? createClient() : undefined);
  selectSession(state, "agent:main:fork", { updatedAt: 0, parentSessionKey: parentKey });
  state.sessionsResult!.ts = 0;
  Object.assign(state, {
    chatLoading: false,
    chatModelCatalogInitialized: true,
    chatMessage: "Keep this draft",
    chatMessages: [{ role: "assistant", content: "Review complete.", timestamp: 1_000 }],
  });
  draw();
  expect(pane.chatProps?.canSend).toBe(true);
  expect(q(".agent-chat__disabled-banner")).toBeNull();
  const reply = q<HTMLButtonElement>(".chat-reply-btn");
  expect(reply).not.toBeNull();
  reply!.click();
  draw();
  expect(q(".chat-reply-preview__text")?.textContent).toBe("Review complete.");
  expect(q<HTMLTextAreaElement>("textarea")?.value).toBe("Keep this draft");
});
