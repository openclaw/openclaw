/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import { buildCatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { resetComposerFixture } from "./chat-composer.test-support.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import { refreshChatMetadata, retireChatMetadataRequests } from "./chat-state-refresh.ts";
import { renderChat } from "./chat-view.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

const defaults = { modelProvider: null, model: null, contextTokens: null };

afterEach(async () => {
  await resetComposerFixture();
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
    { spawnedBy: "agent:main:parent" },
    { parentSessionKey: "agent:main:parent" },
    { spawnedBy: "agent:main:controller", parentSessionKey: "agent:main:parent" },
    {
      key: "agent:main:worker",
      classification: "subagent" as const,
      spawnedBy: "agent:main:parent",
    },
  ])("replaces input with parent navigation for %j", (lineage) => {
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
    state.sessionsResult = { ts: 2, path: "", count: 2, defaults, sessions: [parent, child] };
    state.chatMessage = "Retained draft";
    pane.onPaneSessionChange = vi.fn();
    state.handleSendChat = vi.fn();
    pane.render();
    const props = pane.chatProps!;
    const container = document.createElement("div");
    const onAbort = vi.fn();
    render(renderChatComposer({ ...props, canAbort: true, onAbort }), container);

    expect(props.canSend).toBe(false);
    void props.onSend();
    expect(state.handleSendChat).not.toHaveBeenCalled();
    expect(container.querySelector("textarea, input[type=file]")).toBeNull();
    expect(container.querySelector(".agent-chat__composer-footer")).toBeNull();
    const banner = container.querySelector(".agent-chat__disabled-banner");
    expect(banner?.textContent).toContain("View-only subagent");
    expect(banner?.textContent).toContain("Investigation request");
    banner?.querySelector<HTMLButtonElement>("button")?.click();
    expect(pane.onPaneSessionChange).toHaveBeenCalledWith(pane.paneId, parent.key);
    const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
    expect(stop).not.toBeNull();
    stop?.click();
    expect(onAbort).toHaveBeenCalledOnce();
  });
  it.each([false, true])("keeps an unresolved subagent view-only with metadata=%s", (hasRow) => {
    const { pane, state } = createRefreshChatPane();
    state.sessionKey = "agent:main:subagent:unresolved";
    state.sessionsResult = {
      ts: 0,
      path: "",
      count: 0,
      defaults,
      sessions: hasRow
        ? [{ key: state.sessionKey, kind: "direct", updatedAt: 0, spawnedBy: "agent:main:missing" }]
        : [],
    };
    pane.render();
    const container = document.createElement("div");
    render(renderChatComposer(pane.chatProps!), container);
    expect(pane.chatProps?.canSend).toBe(false);
    expect(container.querySelector("textarea")).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(".agent-chat__disabled-banner button")?.disabled,
    ).toBe(!hasRow);
    expect(container.querySelector('[aria-label="Stop generating"]')).toBeNull();
  });

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
