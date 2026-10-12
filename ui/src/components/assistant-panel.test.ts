/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { RouteId } from "../app-route-paths.ts";
import { AssistantDock } from "../app/assistant-dock.ts";
import { chatInputOwnerForContext } from "../app/chat-input-owner.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  SESSION_NAVIGATION_INTENT_EVENT,
  type SessionNavigationIntent,
} from "../lib/sessions/navigation-handoff.ts";
import {
  CHAT_ROUTE_READY_EVENT,
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
} from "../pages/chat/chat-history-events.ts";
import { publishChatWorkContext, type ChatWorkContext } from "../pages/chat/chat-work-context.ts";
import { createContext } from "../pages/custodian/custodian-page.test-harness.ts";
import { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
} from "../pages/custodian/plugin-help.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT, HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./assistant-panel.ts";
import "./assistant-panel-content.ts";

vi.mock("./home-session.runtime.ts", () => {
  if (!customElements.get("openclaw-home-session")) {
    customElements.define("openclaw-home-session", class extends HTMLElement {});
  }
  return {};
});

type TestAssistantPanel = HTMLElement & {
  custodianAvailable: boolean;
  homeAvailable: boolean;
  pageRouteId: RouteId;
  pageSessionKey: string;
  pageAgentId: string;
  pageRouteFailed: boolean;
  assistantPanelOpen: boolean;
  minimizeRequestId: number;
  store: CustodianSessionStore;
  custodianSuppressed: boolean;
  updateComplete: Promise<boolean>;
};

async function mountPanel(options: { global?: boolean } = {}) {
  const request = vi.fn().mockResolvedValue({
    sessionId: "panel-session",
    reply: "Ready.",
    action: "none",
  });
  const { context: baseContext, setGatewaySnapshot } = createContext(
    request,
    ["openclaw.chat", "chat.history", "chat.send"],
    {
      agentsList: {
        defaultId: "main",
        mainKey: "home",
        scope: options.global ? "global" : "per-sender",
        agents: [
          { id: "main", model: { primary: "openai/gpt-5.5" } },
          { id: "research" },
          { id: "care", kind: "system" },
        ],
      },
    },
  );
  const context = {
    ...baseContext,
    assistantDock: new AssistantDock(),
    sessions: createSessionCapability(baseContext.gateway, baseContext.agentSelection),
  };
  // The app owns this capability; removing its panel does not stop subscription retries.
  onTestFinished(() => context.sessions.dispose());
  const provider = createApplicationContextProvider(context);
  const store = new CustodianSessionStore();
  const panel = document.createElement("openclaw-assistant-panel") as TestAssistantPanel;
  panel.store = store;
  panel.custodianAvailable = true;
  panel.custodianSuppressed = true;
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  return { context, panel, provider, request, setGatewaySnapshot, store };
}

async function restoreHomePanel() {
  const { panel } = await mountPanel();
  panel.homeAvailable = true;
  await panel.updateComplete;
  window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
  await vi.dynamicImportSettled();
  await panel.updateComplete;
  expect(panel.querySelector("openclaw-home-session")).not.toBeNull();
  panel.remove();
  const restored = await mountPanel();
  restored.panel.homeAvailable = true;
  restored.panel.pageSessionKey = "agent:main:task";
  await restored.panel.updateComplete;
  return restored;
}

function message(id: number, role: "assistant" | "user", text: string) {
  return { id, role, text, at: id, question: null, step: null };
}

describe("assistant panel", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--oc-assistant-reserve-bottom");
    document.documentElement.style.removeProperty("--oc-assistant-reserve-right");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("mounts an unavailable panel before application context is supplied", async () => {
    const panel = document.createElement("openclaw-assistant-panel");
    document.body.append(panel);

    await panel.updateComplete;

    expect(panel.querySelector<HTMLElement>(".assistant-panel")?.hidden).toBe(true);
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it.each([false, true])(
    "admits same-route Home selection through the pane owner (global=%s)",
    async (global) => {
      const { panel, context } = await mountPanel({ global });
      panel.homeAvailable = true;
      panel.pageRouteId = "chat";
      panel.pageSessionKey = global ? "global" : "agent:main:home";
      panel.pageAgentId = "main";
      await panel.updateComplete;
      let intent: SessionNavigationIntent | undefined;
      const receive = (event: Event) => {
        event.preventDefault();
        intent = (event as CustomEvent<SessionNavigationIntent>).detail;
      };
      window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, receive);
      onTestFinished(() => window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, receive));
      const navigate = vi.spyOn(context, "navigate");
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      expect(intent).toMatchObject({
        sessionKey: panel.pageSessionKey,
        agentId: "main",
        face: "chat",
      });
      expect(navigate).not.toHaveBeenCalled();
      expect(intent!.commit()).toBe(true);
      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/main" }),
      );
      expect(intent!.commit()).toBe(false);
    },
  );

  it.each(["page", "agent", "gateway", "disconnect"])(
    "retires a deferred Home selection after %s changes",
    async (retirement) => {
      const { panel, context } = await mountPanel();
      panel.homeAvailable = true;
      panel.pageRouteId = "chat";
      panel.pageSessionKey = "agent:main:home";
      panel.pageAgentId = "main";
      await panel.updateComplete;
      let intent: SessionNavigationIntent | undefined;
      const receive = (event: Event) => {
        event.preventDefault();
        intent = (event as CustomEvent<SessionNavigationIntent>).detail;
      };
      window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, receive);
      onTestFinished(() => window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, receive));
      const navigate = vi.spyOn(context, "navigate");
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      expect(intent).toBeDefined();
      if (retirement === "page") {
        panel.pageSessionKey = "agent:main:other";
      } else if (retirement === "agent") {
        context.agentSelection.state.selectedId = "research";
      } else if (retirement === "gateway") {
        context.gateway.snapshot.hello = null;
      } else {
        panel.remove();
      }
      expect(intent!.commit()).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "follows the sidebar agent switcher and suppresses only the selected conversation (global=%s)",
    async (global) => {
      const { context, panel, store } = await mountPanel({ global });
      const refresh = vi.spyOn(store, "refreshTranscriptIfIdle");
      panel.homeAvailable = true;
      panel.custodianAvailable = false;
      panel.pageSessionKey = "agent:research:task";
      panel.pageAgentId = "research";
      panel.pageRouteId = "chat";
      await panel.updateComplete;
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      await vi.dynamicImportSettled();
      await panel.updateComplete;
      const home = () =>
        panel.querySelector<HTMLElement & { sessionKey: string; agentId: string }>(
          "openclaw-home-session",
        );
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:main:home");
      expect(home()?.agentId).toBe("main");
      expect(refresh).not.toHaveBeenCalled();
      expect(chatInputOwnerForContext(context).current).toBe("dock");
      // One switcher: the dock renders no agent selector of its own.
      expect(panel.querySelector("select")).toBeNull();

      // The dock follows the sidebar agent switcher.
      context.agentSelection.state.selectedId = "research";
      panel.pageSessionKey = "agent:research:other-task";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:research:home");
      expect(panel.assistantPanelOpen).toBe(true);

      // System agents stay valid chat targets elsewhere but never become the dock target.
      context.agentSelection.state.selectedId = "care";
      panel.pageSessionKey = "agent:research:task";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("main");
      context.agentSelection.state.selectedId = "research";

      // The selected agent's own Home page suppresses the dock; leaving restores it.
      panel.pageSessionKey = global ? "global" : "agent:research:home";
      await panel.updateComplete;
      expect(home()).toBeNull();
      expect(chatInputOwnerForContext(context).current).toBe("page");
      panel.pageRouteId = "appearance";
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");

      context.gateway.snapshot.phase = "offline";
      context.gateway.snapshot.hello = null;
      context.agents.state.agentsList = null;
      panel.pageSessionKey = "agent:research:offline-task";
      await panel.updateComplete;
      expect(home()?.sessionKey).toBe(global ? "global" : "agent:research:home");
      expect(home()?.agentId).toBe("research");
      window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
      await panel.updateComplete;
      expect(home()?.agentId).toBe("research");
      panel.remove();
      expect(chatInputOwnerForContext(context).current).toBe("page");
    },
  );

  it.each([HOME_PANEL_TOGGLE_EVENT, CUSTODIAN_PANEL_TOGGLE_EVENT])(
    "replaces %s with an activation-owned session and follows navigation without restoring closed docks",
    async (eventName) => {
      const { context, panel, store } = await mountPanel();
      const refresh = vi.spyOn(store, "refreshTranscriptIfIdle");
      panel.homeAvailable = true;
      panel.custodianSuppressed = false;
      panel.pageRouteId = "plugin";
      await panel.updateComplete;
      window.dispatchEvent(new CustomEvent(eventName));
      await vi.dynamicImportSettled();
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(true);
      if (eventName === CUSTODIAN_PANEL_TOGGLE_EVENT) {
        expect(refresh).toHaveBeenCalled();
      }
      const activation = {};
      const hint = { page: "review:board", detail: { filter: "stuck" } };
      const keys: (string | null)[] = [];
      const stop = context.assistantDock.subscribe(() =>
        keys.push(context.assistantDock.openSessionKey),
      );
      onTestFinished(stop);
      context.assistantDock.openSession(
        {
          sessionKey: "agent:research:review",
          agentId: "research",
          label: "Review conversation",
          context: hint,
        },
        activation,
      );
      hint.detail.filter = "changed after opening";
      await panel.updateComplete;
      const home = () =>
        panel.querySelector<
          HTMLElement & {
            sessionKey: string;
            agentId: string;
            workContext: ChatWorkContext;
          }
        >("openclaw-home-session");
      expect(home()).toMatchObject({
        sessionKey: "agent:research:review",
        agentId: "research",
        workContext: { page: "review:board", detail: { filter: "stuck" } },
      });
      expect(panel.textContent).toContain("Review conversation");
      expect(panel.querySelector("openclaw-custodian-surface")).toBeNull();
      expect(context.assistantDock.openSessionKey).toBe("agent:research:review");
      panel.pageRouteId = "appearance";
      await panel.updateComplete;
      expect(home()).not.toBeNull();
      panel.pageSessionKey = "agent:research:review";
      panel.pageAgentId = "research";
      for (const route of ["chat", "dashboard"] as const) {
        panel.pageRouteId = route;
        await panel.updateComplete;
        expect(home(), route).toBeNull();
        expect(context.assistantDock.openSessionKey).toBeNull();
        panel.pageRouteId = "plugin";
        await panel.updateComplete;
        expect(home()?.sessionKey).toBe("agent:research:review");
      }
      context.assistantDock.close({});
      expect(panel.assistantPanelOpen).toBe(true);
      context.assistantDock.close(activation);
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(false);
      // The built-in choice the plugin dock replaced survives its close, persisted and live.
      const builtIn = eventName === HOME_PANEL_TOGGLE_EVENT ? "home" : "custodian";
      const storedTargets = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index),
      )
        .filter((key) => key?.startsWith("openclaw.assistant.panel.target.v1:"))
        .map((key) => JSON.parse(localStorage.getItem(key ?? "") ?? "null")?.destination);
      expect(storedTargets).toEqual([builtIn]);
      window.dispatchEvent(new CustomEvent(eventName));
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(true);
      expect(context.assistantDock.openSessionKey).toBeNull();
      expect(panel.querySelector("openclaw-custodian-surface") === null).toBe(builtIn === "home");
      window.dispatchEvent(new CustomEvent(eventName));
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(false);
      panel.pageRouteId = "appearance";
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(false);
      expect(keys).toEqual([
        "agent:research:review",
        null,
        "agent:research:review",
        null,
        "agent:research:review",
        null,
      ]);
    },
  );

  it("keeps a closed plugin dock closed when automatic Ask help arrived while it was open", async () => {
    vi.stubGlobal("innerWidth", 1342);
    const { context, panel } = await mountPanel();
    panel.custodianSuppressed = false;
    panel.pageRouteId = "plugin-settings";
    await panel.updateComplete;
    context.assistantDock.openSession(
      { sessionKey: "agent:main:review", agentId: "main", label: "Review" },
      {},
    );
    publishPluginHelpContext(
      context,
      {},
      { id: "example", name: "Example" },
      { overview: true, installed: true },
    );
    await panel.updateComplete;
    expect(context.assistantDock.openSessionKey).toBe("agent:main:review");
    panel.querySelector<HTMLButtonElement>(".assistant-panel-actions button:last-child")!.click();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    expect(context.assistantDock.openSessionKey).toBeNull();
  });

  it("opens for read-only viewers and distinguishes agents sharing a global session key", async () => {
    const { context, panel, setGatewaySnapshot } = await mountPanel({ global: true });
    const hello = context.gateway.snapshot.hello!;
    setGatewaySnapshot({
      hello: { ...hello, auth: { role: "operator", scopes: ["operator.read"] } },
    });
    panel.homeAvailable = false;
    panel.custodianAvailable = false;
    panel.pageSessionKey = "global";
    panel.pageAgentId = "main";
    await panel.updateComplete;
    context.assistantDock.openSession(
      { sessionKey: "global", agentId: "research", label: "Research" },
      {},
    );
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(panel.querySelector("openclaw-home-session")).toMatchObject({
      sessionKey: "global",
      agentId: "research",
    });
    panel.pageAgentId = "research";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    panel.pageAgentId = "main";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("prepares current route and pane context when Home opens and the visible work changes", async () => {
    const { context, panel, provider, request, setGatewaySnapshot } = await mountPanel({
      global: true,
    });
    context.sessions.state.result = {
      ts: 0,
      path: "",
      count: 2,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        { key: "global", agentId: "main", kind: "global", updatedAt: 0, label: "Personal Home" },
        {
          key: "global",
          agentId: "research",
          kind: "global",
          updatedAt: 0,
          label: "Parser work",
          sessionId: "research-incarnation",
          spawnedWorkspaceDir: "/worktrees/parser",
        },
      ],
    };
    panel.pageSessionKey = "global";
    panel.pageAgentId = "research";
    panel.homeAvailable = true;
    const pane = {};
    publishChatWorkContext(context, pane, {
      sessionKey: "global",
      agentId: "research",
      file: "src/parser.ts",
    });
    await panel.updateComplete;
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    const workContext = () =>
      panel.querySelector<HTMLElement & { workContext: ChatWorkContext }>("openclaw-home-session")
        ?.workContext;
    const expected = {
      page: "chat",
      sessionKey: "global",
      agentId: "research",
      sessionId: "research-incarnation",
      title: "Parser work",
      workspace: "/worktrees/parser",
      file: "src/parser.ts",
    };
    expect(workContext()).toEqual(expected);
    panel.pageRouteId = "appearance";
    await panel.updateComplete;
    expect(workContext()).toEqual({ page: "appearance" });
    panel.pageRouteId = "chat";
    publishChatWorkContext(context, pane, {
      sessionKey: "global",
      agentId: "research",
      file: "src/tokenizer.ts",
    });
    await panel.updateComplete;
    expect(workContext()).toEqual({ ...expected, file: "src/tokenizer.ts" });
    publishChatWorkContext(context, pane);
    await panel.updateComplete;
    const { file: _file, ...withoutFile } = expected;
    expect(workContext()).toEqual(withoutFile);

    // Capability snapshots can change while every route and pane input stays fixed.
    const agents = createAgentCapability(context.gateway);
    try {
      agents.state.agentsList = {
        defaultId: "research",
        mainKey: "home",
        scope: "per-sender",
        agents: [{ id: "main" }, { id: "research", workspace: "/projects/research" }],
      };
      context.sessions.state.result = {
        ...context.sessions.state.result!,
        sessions: [
          { key: "agent:research:home", agentId: "research", kind: "direct", updatedAt: 0 },
          { key: "agent:research:current", agentId: "research", kind: "direct", updatedAt: 0 },
        ],
      };
      provider.setContext({ ...context, agents });
      panel.pageSessionKey = "agent:research:main";
      await panel.updateComplete;
      expect(workContext()).toMatchObject({
        sessionKey: "agent:research:home",
        agentId: "research",
        workspace: "/projects/research",
      });

      request.mockResolvedValueOnce({
        ...agents.state.agentsList,
        agents: [{ id: "main" }, { id: "research", workspace: "/worktrees/research" }],
      });
      await agents.refreshList();
      await panel.updateComplete;
      expect(workContext()?.workspace).toBe("/worktrees/research");

      request.mockResolvedValue(context.sessions.state.result);
      const hello = context.gateway.snapshot.hello!;
      setGatewaySnapshot({
        hello: {
          ...hello,
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "research",
              mainKey: "home",
              mainSessionKey: "agent:research:current",
            },
          },
        },
      });
      await panel.updateComplete;
      expect(workContext()).toMatchObject({
        title: "agent:research:current",
        sessionKey: "agent:research:current",
        agentId: "research",
        workspace: "/worktrees/research",
      });

      const detachedHome = panel.querySelector<HTMLElement & { workContext?: ChatWorkContext }>(
        "openclaw-home-session",
      );
      const disconnectedContext = detachedHome?.workContext;
      panel.remove();
      request.mockResolvedValueOnce({
        ...agents.state.agentsList,
        agents: [{ id: "main" }, { id: "research", workspace: "/projects/other" }],
      });
      await agents.refreshList();
      setGatewaySnapshot({ hello });
      await panel.updateComplete;
      expect(detachedHome?.workContext).toEqual(disconnectedContext);

      provider.append(panel);
      await panel.updateComplete;
      request.mockResolvedValueOnce({
        ...agents.state.agentsList,
        agents: [{ id: "main" }, { id: "research", workspace: "/projects/reconnected" }],
      });
      await agents.refreshList();
      await panel.updateComplete;
      expect(workContext()?.workspace).toBe("/projects/reconnected");
    } finally {
      agents.dispose();
    }
  });

  it("restores Home only after the selected transcript has rendered, preserving dock geometry", async () => {
    const { panel: replacement, provider } = await restoreHomePanel();
    const home = () => replacement.querySelector("openclaw-home-session");
    expect(replacement.assistantPanelOpen).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right")).toBe(
      "440px",
    );
    expect(home()).toBeNull();

    let finishRender!: () => void;
    const pane = Object.assign(document.createElement("openclaw-chat-pane"), {
      sessionKey: "agent:main:task",
      presented: true,
      transcriptReady: false,
      updateComplete: new Promise<void>((resolve) => {
        finishRender = resolve;
      }),
    });
    pane.classList.add("chat-pane-cache__pane--active");
    provider.prepend(pane);
    pane.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT, { bubbles: true }));
    await replacement.updateComplete;
    expect(home()).toBeNull();
    pane.transcriptReady = true;
    pane.dispatchEvent(new Event(CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, { bubbles: true }));
    await replacement.updateComplete;
    expect(home()).toBeNull();
    // A superseded route must not release Home from the old pane's late commit.
    replacement.pageSessionKey = "agent:main:next-task";
    await replacement.updateComplete;
    finishRender();
    await pane.updateComplete;
    await replacement.updateComplete;
    expect(home()).toBeNull();
    replacement.pageSessionKey = "agent:main:task";
    await replacement.updateComplete;
    await vi.waitFor(() => expect(home()).not.toBeNull());
    expect(document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right")).toBe(
      "440px",
    );

    replacement.pageSessionKey = "agent:main:next-task";
    await replacement.updateComplete;
    expect(home()).not.toBeNull();
  });

  it.each(["explicit", "non-chat", "failed"] as const)(
    "releases restored Home without a primary transcript for %s navigation",
    async (release) => {
      const { panel: replacement } = await restoreHomePanel();
      expect(replacement.querySelector("openclaw-home-session")).toBeNull();
      if (release === "explicit") {
        window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
      } else if (release === "non-chat") {
        replacement.pageRouteId = "appearance";
        replacement.custodianSuppressed = false;
      } else {
        replacement.pageRouteFailed = true;
      }
      await replacement.updateComplete;
      expect(replacement.querySelector("openclaw-home-session")).not.toBeNull();
      if (release === "non-chat") {
        const home = replacement.querySelector<HTMLElement & { agentId: string }>(
          "openclaw-home-session",
        );
        expect(home?.agentId).toBe("main");
        expect(replacement.assistantPanelOpen).toBe(true);
        window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
        await replacement.updateComplete;
        expect(replacement.querySelector("openclaw-home-session")).toBeNull();
        expect(replacement.querySelector("openclaw-custodian-surface")).not.toBeNull();
        expect(replacement.querySelectorAll(".assistant-panel")).toHaveLength(1);
      }
    },
  );

  it.each([
    { variant: "caretaker", available: true },
    { variant: "caretaker", available: false },
    { variant: "onboarding", available: true },
  ] as const)(
    "minimizes the existing $variant conversation when available=$available",
    async ({ variant, available }) => {
      const { context, panel, request, store } = await mountPanel();
      store.connect(context, variant);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const userText = variant === "onboarding" ? "Continue setup" : "Check this system";
      store.messages = [message(available ? 2 : 1, "user", userText)];
      if (available) {
        store.messages.unshift(
          message(1, "assistant", variant === "onboarding" ? "Set up your system" : "Ready."),
        );
      }
      panel.custodianAvailable = available;
      panel.custodianSuppressed = false;
      panel.minimizeRequestId = 1;
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(available);
      if (!available) {
        panel.custodianAvailable = true;
        await panel.updateComplete;
      }
      const surface = panel.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "openclaw-custodian-surface",
      );
      await surface?.updateComplete;
      expect(panel.assistantPanelOpen).toBe(true);
      expect(store.activeVariant).toBe(variant);
      expect(request).toHaveBeenCalledOnce();
      expect(panel.textContent).toContain(userText);
      expect(document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right")).toBe(
        "440px",
      );
      panel
        .querySelector<HTMLButtonElement>(
          ".assistant-panel-actions .assistant-panel-icon:last-child",
        )!
        .click();
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(false);
      panel.custodianSuppressed = true;
      await panel.updateComplete;
      panel.custodianSuppressed = false;
      panel.minimizeRequestId = 2;
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(true);
    },
  );

  it.each([
    { width: 900, installed: true },
    { width: 1342, installed: true },
    { width: 1342, installed: false },
  ])(
    "opens plugin help on request and limits automatic opening (width=$width, installed=$installed)",
    async ({ width, installed }) => {
      vi.stubGlobal("innerWidth", width);
      const { context, panel, request } = await mountPanel();
      panel.custodianSuppressed = false;
      if (installed) {
        panel.pageRouteId = "plugin-settings";
      }
      await panel.updateComplete;
      const owner = {};
      publishPluginHelpContext(
        context,
        owner,
        { id: "first", name: "First" },
        { overview: true, installed },
      );
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(installed && width > 1100);
      await createPluginHelpRequest(context, { id: "first", name: "First" })();
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(true);
      window.dispatchEvent(
        new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: false } }),
      );
      await panel.updateComplete;
      publishPluginHelpContext(
        context,
        owner,
        { id: "second", name: "Second" },
        { overview: true, installed },
      );
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(false);
      publishPluginHelpContext(
        context,
        owner,
        { id: "second", name: "Second" },
        { overview: false, installed },
      );
      await panel.updateComplete;
      expect(panel.assistantPanelOpen).toBe(false);
      expect(request.mock.calls.every((call) => call[1]?.message === undefined)).toBe(true);
    },
  );

  it("suppresses automatic Ask OpenClaw restores in Settings while keeping explicit opens usable", async () => {
    const { panel } = await mountPanel();
    panel.custodianSuppressed = false;
    await panel.updateComplete;
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);

    panel.pageRouteId = "updates";
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);

    panel.remove();
    const { panel: restored } = await mountPanel();
    restored.custodianSuppressed = false;
    restored.pageRouteId = "updates";
    await restored.updateComplete;
    expect(restored.assistantPanelOpen).toBe(false);
    restored.pageRouteId = "agents-home";
    await restored.updateComplete;
    expect(restored.assistantPanelOpen).toBe(true);
  });

  it.each(["right", "bottom"])("drags only passive header chrome when docked %s", async (dock) => {
    const { panel } = await mountPanel();
    panel.custodianSuppressed = false;
    await panel.updateComplete;
    window.dispatchEvent(
      new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true, dock } }),
    );
    await panel.updateComplete;

    const postMessage = vi.fn();
    vi.stubGlobal("webkit", { messageHandlers: { openclawWindowDrag: { postMessage } } });
    const cases = [
      [".assistant-panel-header", true],
      [".assistant-panel-title", true],
      [".assistant-panel-actions", true],
      [".assistant-panel-actions button:first-child", false],
      [".assistant-panel-actions button:first-child svg", false],
      [".assistant-panel-actions button:last-child", false],
      [".assistant-panel-actions button:last-child svg", false],
      ["openclaw-custodian-surface", false],
    ] as const;
    for (const [selector, draggable] of cases) {
      postMessage.mockClear();
      const target = panel.querySelector(selector);
      expect(target, selector).not.toBeNull();
      const event = new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
      });
      target!.dispatchEvent(event);
      expect(postMessage, selector).toHaveBeenCalledTimes(draggable ? 1 : 0);
      if (draggable) {
        expect(postMessage).toHaveBeenCalledWith({ type: "window-drag" });
      }
      expect(event.defaultPrevented, selector).toBe(draggable);
    }

    panel.querySelector<HTMLButtonElement>(".assistant-panel-actions button:first-child")!.click();
    await panel.updateComplete;
    expect(
      panel.querySelector(`.assistant-panel--${dock === "right" ? "bottom" : "right"}`),
    ).not.toBeNull();
    panel.querySelector<HTMLButtonElement>(".assistant-panel-actions button:last-child")!.click();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it("ignores toggle requests while unavailable", async () => {
    const { panel } = await mountPanel();
    panel.custodianAvailable = false;
    panel.custodianSuppressed = false;
    await panel.updateComplete;

    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
    await panel.updateComplete;

    expect(panel.assistantPanelOpen).toBe(false);
  });

  it("updates the panel mascot mood with shared sending state", async () => {
    const { panel, store } = await mountPanel();
    store.messages = [
      { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
    ];
    panel.custodianSuppressed = false;
    panel.minimizeRequestId = 1;
    await panel.updateComplete;

    store.sending = true;
    store.setInput("status");
    await panel.updateComplete;

    expect(
      (
        panel.querySelector(".assistant-panel-title openclaw-mascot") as HTMLElement & {
          mood: string;
        }
      ).mood,
    ).toBe("thinking");
  });
});
