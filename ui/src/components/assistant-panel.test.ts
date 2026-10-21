/* @vitest-environment jsdom */

import type { SystemAgentChatHistoryResult } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
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
import { publishChatWorkContext } from "../pages/chat/chat-work-context.ts";
import { createContext } from "../pages/custodian/custodian-page.test-harness.ts";
import { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import {
  publishPluginHelpContext,
  createPluginHelpRequest,
} from "../pages/custodian/plugin-help.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { domProbe } from "../test-helpers/dom-probe.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { CUSTODIAN_PANEL_TOGGLE_EVENT, HOME_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./assistant-panel-solid.tsx";
import "./assistant-panel-content.ts";

type HomeProps = Parameters<typeof import("./home-session-solid.tsx").HomeSession>[0];
type TestHome = HTMLElement & HomeProps;

// mock-isolation: The parent panel owns orchestration; Home is an opaque renderer.
vi.mock("./home-session-solid.tsx", () => ({
  HomeSession(props: HomeProps) {
    const host = document.createElement("openclaw-home-session");
    for (const key of ["sessionKey", "agentId", "workContext"] as const) {
      Object.defineProperty(host, key, { get: () => props[key] });
    }
    return host;
  },
}));

type TestAssistantPanel = HTMLElementTagNameMap["openclaw-assistant-panel"];

async function mountPanel({
  global,
  history,
  ...options
}: Partial<TestAssistantPanel> & {
  global?: boolean;
  history?: SystemAgentChatHistoryResult;
} = {}) {
  const reply = { sessionId: "panel-session", reply: "Ready.", action: "none" };
  const request = vi.fn().mockResolvedValue(reply);
  if (history) {
    request.mockImplementation(async (method: string) =>
      method === "openclaw.chat.history" ? history : reply,
    );
  }
  const { context: baseContext, setGatewaySnapshot } = createContext(
    request,
    ["openclaw.chat", "chat.history", "chat.send", ...(history ? ["openclaw.chat.history"] : [])],
    {
      agentsList: {
        defaultId: "main",
        mainKey: "home",
        scope: global ? "global" : "per-sender",
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
  const panel = document.createElement("openclaw-assistant-panel");
  Object.assign(panel, { store, custodianAvailable: true, custodianSuppressed: true });
  provider.append(panel);
  document.body.append(provider);
  await panel.updateComplete;
  await update(panel, options);
  return { context, panel, provider, request, setGatewaySnapshot, store, dom: domProbe(panel) };
}

async function update(panel: TestAssistantPanel, values: Partial<TestAssistantPanel>) {
  Object.assign(panel, values);
  await panel.updateComplete;
}
async function click(panel: TestAssistantPanel, selector: string) {
  panel.querySelector<HTMLElement>(selector)!.click();
  await panel.updateComplete;
}
function home(panel: ParentNode) {
  return panel.querySelector<TestHome>("openclaw-home-session");
}
async function toggle(panel: TestAssistantPanel, event: string, detail?: object) {
  window.dispatchEvent(new CustomEvent(event, { detail }));
  await vi.dynamicImportSettled();
  await panel.updateComplete;
}
async function openHome(panel: TestAssistantPanel) {
  await toggle(panel, HOME_PANEL_TOGGLE_EVENT);
}
function reserveRight() {
  return document.documentElement.style.getPropertyValue("--oc-assistant-reserve-right");
}
function plugin(id: string) {
  return { id, name: id[0]!.toUpperCase() + id.slice(1) };
}
function session(
  key: string,
  agentId: string,
  fields: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return { key, agentId, kind: key === "global" ? "global" : "direct", updatedAt: 0, ...fields };
}
function openReview(dock: AssistantDock, agentId = "research") {
  dock.openSession({ sessionKey: `agent:${agentId}:review`, agentId, label: "Review" }, {});
}
function deferHomeIntent() {
  let intent: SessionNavigationIntent | undefined;
  const receive = (event: Event) => {
    event.preventDefault();
    intent = (event as CustomEvent<SessionNavigationIntent>).detail;
  };
  window.addEventListener(SESSION_NAVIGATION_INTENT_EVENT, receive);
  onTestFinished(() => window.removeEventListener(SESSION_NAVIGATION_INTENT_EVENT, receive));
  return () => intent;
}
async function restoreHomePanel() {
  const { panel } = await mountPanel({ homeAvailable: true });
  await openHome(panel);
  expect(home(panel)).not.toBeNull();
  panel.remove();
  return mountPanel({ homeAvailable: true, pageSessionKey: "agent:main:task" });
}

function researchAgents(workspace: string) {
  return [{ id: "main" }, { id: "research", workspace }];
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

  it("admits same-route Home selection through the pane owner (global=true)", async () => {
    const { panel, context } = await mountPanel({
      global: true,
      homeAvailable: true,
      pageRouteId: "chat",
      pageSessionKey: "global",
      pageAgentId: "main",
    });
    const intent = deferHomeIntent();
    const navigate = vi.spyOn(context, "navigate");
    window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
    expect(intent()).toMatchObject({
      sessionKey: panel.pageSessionKey,
      agentId: "main",
      face: "chat",
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(intent()!.commit()).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ pathname: "/chat/main" }),
    );
    expect(intent()!.commit()).toBe(false);
  });

  it.each(["page", "agent", "gateway", "disconnect"])(
    "retires a deferred Home selection after %s changes",
    async (retirement) => {
      const { panel, context } = await mountPanel({
        homeAvailable: true,
        pageRouteId: "chat",
        pageSessionKey: "agent:main:home",
        pageAgentId: "main",
      });
      const intent = deferHomeIntent();
      const navigate = vi.spyOn(context, "navigate");
      window.dispatchEvent(new CustomEvent(HOME_PANEL_TOGGLE_EVENT));
      expect(intent()).toBeDefined();
      if (retirement === "page") {
        panel.pageSessionKey = "agent:main:other";
      } else if (retirement === "agent") {
        context.agentSelection.state.selectedId = "research";
      } else if (retirement === "gateway") {
        context.gateway.snapshot.hello = null;
      } else {
        panel.remove();
      }
      expect(intent()!.commit()).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("follows the sidebar agent switcher and suppresses only the selected conversation (global=false)", async () => {
    const { context, panel, store, dom } = await mountPanel();
    const refresh = vi.spyOn(store, "refreshTranscriptIfIdle");
    await update(panel, {
      homeAvailable: true,
      custodianAvailable: false,
      pageSessionKey: "agent:research:task",
      pageAgentId: "research",
      pageRouteId: "chat",
    });
    await openHome(panel);
    expect(home(panel)).toMatchObject({ sessionKey: "agent:main:home", agentId: "main" });
    expect(refresh).not.toHaveBeenCalled();
    expect(chatInputOwnerForContext(context).current).toBe("dock");
    expect(dom.query("select")).toBeNull();

    context.agentSelection.state.selectedId = "research";
    await update(panel, { pageSessionKey: "agent:research:other-task" });
    expect(home(panel)).toMatchObject({ sessionKey: "agent:research:home", agentId: "research" });
    expect(panel.assistantPanelOpen).toBe(true);

    context.agentSelection.state.selectedId = "care";
    await update(panel, { pageSessionKey: "agent:research:task" });
    expect(home(panel)?.agentId).toBe("main");
    context.agentSelection.state.selectedId = "research";

    await update(panel, { pageSessionKey: "agent:research:home" });
    expect(home(panel)).toBeNull();
    expect(chatInputOwnerForContext(context).current).toBe("page");
    await update(panel, { pageRouteId: "appearance" });
    expect(home(panel)?.agentId).toBe("research");

    context.gateway.snapshot.phase = "offline";
    context.gateway.snapshot.hello = null;
    context.agents.state.agentsList = null;
    await update(panel, { pageSessionKey: "agent:research:offline-task" });
    expect(home(panel)).toMatchObject({ sessionKey: "agent:research:home", agentId: "research" });
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
    expect(home(panel)?.agentId).toBe("research");
    panel.remove();
    expect(chatInputOwnerForContext(context).current).toBe("page");
  });

  it("replaces the custodian with an activation-owned session and follows navigation without restoring closed docks", async () => {
    const { context, panel, store, dom } = await mountPanel();
    const refresh = vi.spyOn(store, "refreshTranscriptIfIdle");
    await update(panel, {
      homeAvailable: true,
      custodianSuppressed: false,
      pageRouteId: "plugin",
    });
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
    expect(panel.assistantPanelOpen).toBe(true);
    expect(refresh).toHaveBeenCalled();
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
    expect(home(panel)).toMatchObject({
      sessionKey: "agent:research:review",
      agentId: "research",
      workContext: { page: "review:board", detail: { filter: "stuck" } },
    });
    expect(panel.textContent).toContain("Review conversation");
    expect(dom.query("openclaw-custodian-surface")).toBeNull();
    expect(context.assistantDock.openSessionKey).toBe("agent:research:review");
    await update(panel, { pageRouteId: "appearance" });
    expect(home(panel)).not.toBeNull();
    panel.pageSessionKey = "agent:research:review";
    panel.pageAgentId = "research";
    for (const route of ["chat", "dashboard"] as const) {
      await update(panel, { pageRouteId: route });
      expect(home(panel), route).toBeNull();
      expect(context.assistantDock.openSessionKey).toBeNull();
      await update(panel, { pageRouteId: "plugin" });
      expect(home(panel)?.sessionKey).toBe("agent:research:review");
    }
    context.assistantDock.close({});
    expect(panel.assistantPanelOpen).toBe(true);
    context.assistantDock.close(activation);
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    const storedTargets = Array.from({ length: localStorage.length }, (_, index) =>
      localStorage.key(index),
    )
      .filter((key) => key?.startsWith("openclaw.assistant.panel.target.v1:"))
      .map((key) => JSON.parse(localStorage.getItem(key ?? "") ?? "null")?.destination);
    expect(storedTargets).toEqual(["custodian"]);
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
    expect(panel.assistantPanelOpen).toBe(true);
    expect(context.assistantDock.openSessionKey).toBeNull();
    expect(dom.query("openclaw-custodian-surface")).not.toBeNull();
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
    expect(panel.assistantPanelOpen).toBe(false);
    await update(panel, { pageRouteId: "appearance" });
    expect(panel.assistantPanelOpen).toBe(false);
    expect(keys).toEqual([
      "agent:research:review",
      null,
      "agent:research:review",
      null,
      "agent:research:review",
      null,
    ]);
  });

  it("retains plugin intent across context replacement and retires it on element removal", async () => {
    const { context, panel, provider } = await mountPanel({
      custodianSuppressed: false,
      pageRouteId: "plugin",
    });
    openReview(context.assistantDock);
    await panel.updateComplete;
    const assistantDock = new AssistantDock();
    const replacementContext = { ...context, assistantDock };
    provider.setContext(replacementContext);
    await panel.updateComplete;
    expect(context.assistantDock.openSessionKey).toBeNull();
    expect(assistantDock.openSessionKey).toBe("agent:research:review");
    expect(panel.textContent).toContain("Review");

    panel.remove();
    await panel.updateComplete;
    expect(assistantDock.openSessionKey).toBeNull();
    expect(chatInputOwnerForContext(replacementContext).current).toBe("page");
    provider.append(panel);
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
    expect(assistantDock.openSessionKey).toBeNull();
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it("keeps a closed plugin dock closed when automatic Ask help arrived while it was open", async () => {
    vi.stubGlobal("innerWidth", 1342);
    const { context, panel } = await mountPanel({
      custodianSuppressed: false,
      pageRouteId: "plugin-settings",
    });
    openReview(context.assistantDock, "main");
    publishPluginHelpContext(context, {}, plugin("example"), { overview: true, installed: true });
    await panel.updateComplete;
    expect(context.assistantDock.openSessionKey).toBe("agent:main:review");
    await click(panel, ".assistant-panel-actions button:last-child");
    expect(panel.assistantPanelOpen).toBe(false);
    expect(context.assistantDock.openSessionKey).toBeNull();
  });

  it("opens for read-only viewers and distinguishes agents sharing a global session key", async () => {
    const { context, panel, setGatewaySnapshot } = await mountPanel({ global: true });
    const hello = context.gateway.snapshot.hello!;
    setGatewaySnapshot({
      hello: { ...hello, auth: { role: "operator", scopes: ["operator.read"] } },
    });
    await update(panel, {
      homeAvailable: false,
      custodianAvailable: false,
      pageSessionKey: "global",
      pageAgentId: "main",
    });
    context.assistantDock.openSession(
      { sessionKey: "global", agentId: "research", label: "Research" },
      {},
    );
    await vi.dynamicImportSettled();
    await panel.updateComplete;
    expect(home(panel)).toMatchObject({ sessionKey: "global", agentId: "research" });
    await update(panel, { pageAgentId: "research" });
    expect(panel.assistantPanelOpen).toBe(false);
    await update(panel, { pageAgentId: "main" });
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
        session("global", "main", { label: "Personal Home" }),
        session("global", "research", {
          label: "Parser work",
          sessionId: "research-incarnation",
          spawnedWorkspaceDir: "/worktrees/parser",
        }),
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
    await openHome(panel);
    const workContext = () => home(panel)?.workContext;
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
    await update(panel, { pageRouteId: "appearance" });
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

    const agents = createAgentCapability(context.gateway);
    const refreshAgents = async (workspace: string) => {
      request.mockResolvedValueOnce({
        ...agents.state.agentsList,
        agents: researchAgents(workspace),
      });
      await agents.refreshList();
    };
    try {
      agents.state.agentsList = {
        defaultId: "research",
        mainKey: "home",
        scope: "per-sender",
        agents: researchAgents("/projects/research"),
      };
      context.sessions.state.result = {
        ...context.sessions.state.result!,
        sessions: [
          session("agent:research:home", "research"),
          session("agent:research:current", "research"),
        ],
      };
      provider.setContext({ ...context, agents });
      await update(panel, { pageSessionKey: "agent:research:main" });
      expect(workContext()).toMatchObject({
        sessionKey: "agent:research:home",
        agentId: "research",
        workspace: "/projects/research",
      });

      await refreshAgents("/worktrees/research");
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

      const detachedHome = home(panel);
      const disconnectedContext = detachedHome?.workContext;
      panel.remove();
      await refreshAgents("/projects/other");
      setGatewaySnapshot({ hello });
      await panel.updateComplete;
      expect(detachedHome?.workContext).toEqual(disconnectedContext);

      provider.append(panel);
      await panel.updateComplete;
      await refreshAgents("/projects/reconnected");
      await panel.updateComplete;
      expect(workContext()?.workspace).toBe("/projects/reconnected");
    } finally {
      agents.dispose();
    }
  });

  it.each(["route replacement", "context replacement", "pane detachment"] as const)(
    "restores Home after the selected transcript renders across %s, preserving dock geometry",
    async (replacement) => {
      const { panel, provider, context } = await restoreHomePanel();
      expect(panel.assistantPanelOpen).toBe(true);
      expect(reserveRight()).toBe("440px");
      expect(home(panel)).toBeNull();

      let finishRender!: () => void;
      const pane = Object.assign(document.createElement("openclaw-chat-pane"), {
        sessionKey: "agent:main:task",
        presented: true,
        transcriptReady: false,
        updateComplete: new Promise<void>((resolve) => {
          finishRender = resolve;
        }),
      });
      provider.prepend(pane);
      let primaryPane: typeof pane | undefined = pane;
      panel.getPrimaryChatPane = (sessionKey) =>
        sessionKey === primaryPane?.sessionKey ? primaryPane : undefined;
      pane.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT, { bubbles: true }));
      await panel.updateComplete;
      expect(home(panel)).toBeNull();
      pane.transcriptReady = true;
      pane.dispatchEvent(new Event(CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, { bubbles: true }));
      await panel.updateComplete;
      expect(home(panel)).toBeNull();
      if (replacement === "route replacement") {
        // A superseded route must not release Home from the old pane's late commit.
        await update(panel, { pageSessionKey: "agent:main:next-task" });
      } else if (replacement === "pane detachment") {
        primaryPane = undefined;
      } else {
        provider.setContext({ ...context });
        await panel.updateComplete;
        expect(home(panel)).toBeNull();
      }
      finishRender();
      await pane.updateComplete;
      await panel.updateComplete;
      if (replacement === "route replacement") {
        expect(home(panel)).toBeNull();
        await update(panel, { pageSessionKey: "agent:main:task" });
      } else if (replacement === "pane detachment") {
        expect(home(panel)).toBeNull();
        primaryPane = pane;
        pane.dispatchEvent(new Event(CHAT_ROUTE_READY_EVENT, { bubbles: true }));
      }
      await vi.waitFor(() => expect(home(panel)).not.toBeNull());
      expect(reserveRight()).toBe("440px");

      await update(panel, { pageSessionKey: "agent:main:next-task" });
      expect(home(panel)).not.toBeNull();
    },
  );

  it.each(["explicit", "non-chat", "failed"] as const)(
    "releases restored Home without a primary transcript for %s navigation",
    async (release) => {
      const { panel, dom } = await restoreHomePanel();
      expect(home(panel)).toBeNull();
      if (release === "explicit") {
        await toggle(panel, HOME_PANEL_TOGGLE_EVENT, { open: true });
      } else if (release === "non-chat") {
        panel.pageRouteId = "appearance";
        panel.custodianSuppressed = false;
      } else {
        panel.pageRouteFailed = true;
      }
      await panel.updateComplete;
      expect(home(panel)).not.toBeNull();
      if (release === "non-chat") {
        const restoredHome = home(panel);
        expect(restoredHome?.agentId).toBe("main");
        expect(panel.assistantPanelOpen).toBe(true);
        await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
        expect(home(panel)).toBeNull();
        expect(dom.query("openclaw-custodian-surface")).not.toBeNull();
        expect(dom.all(".assistant-panel")).toHaveLength(1);
      }
    },
  );

  it("minimizes the existing onboarding conversation when available", async () => {
    const userText = "Continue setup";
    const { context, panel, request, store, dom } = await mountPanel({
      history: {
        turns: [
          { role: "assistant", text: "Set up your system", at: 1 },
          { role: "user", text: userText, at: 2 },
        ],
      },
    });
    store.connect(context, "onboarding");
    const chatRequests = () => request.mock.calls.filter(([method]) => method === "openclaw.chat");
    await vi.waitFor(() => expect(chatRequests()).toHaveLength(1));
    await update(panel, {
      custodianAvailable: true,
      custodianSuppressed: false,
      minimizeRequestId: 1,
    });
    expect(panel.assistantPanelOpen).toBe(true);
    const surface = dom.query<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-custodian-surface",
    );
    await surface?.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
    expect(store.activeVariant).toBe("onboarding");
    expect(chatRequests()).toHaveLength(1);
    expect(panel.textContent).toContain(userText);
    expect(reserveRight()).toBe("440px");
    await click(panel, ".assistant-panel-actions .assistant-panel-icon:last-child");
    expect(panel.assistantPanelOpen).toBe(false);
    await update(panel, { custodianSuppressed: true });
    await update(panel, { custodianSuppressed: false, minimizeRequestId: 2 });
    expect(panel.assistantPanelOpen).toBe(true);
  });

  it("opens plugin help on request and limits automatic opening for installed plugins on desktop", async () => {
    vi.stubGlobal("innerWidth", 1342);
    const { context, panel, request } = await mountPanel({
      custodianSuppressed: false,
      pageRouteId: "plugin-settings",
    });
    const owner = {};
    const publishHelp = async (id: string, overview: boolean) => {
      publishPluginHelpContext(context, owner, plugin(id), { overview, installed: true });
      await panel.updateComplete;
    };
    await publishHelp("first", true);
    expect(panel.assistantPanelOpen).toBe(true);
    await createPluginHelpRequest(context, plugin("first"))();
    await panel.updateComplete;
    expect(panel.assistantPanelOpen).toBe(true);
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT, { open: false });
    await publishHelp("second", true);
    expect(panel.assistantPanelOpen).toBe(false);
    await publishHelp("second", false);
    expect(panel.assistantPanelOpen).toBe(false);
    expect(request.mock.calls.every((call) => call[1]?.message === undefined)).toBe(true);
  });

  it("suppresses automatic Ask OpenClaw restores in Settings while keeping explicit opens usable", async () => {
    const { panel } = await mountPanel({ custodianSuppressed: false });
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
    expect(panel.assistantPanelOpen).toBe(true);

    await update(panel, { pageRouteId: "updates" });
    expect(panel.assistantPanelOpen).toBe(false);
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT);
    expect(panel.assistantPanelOpen).toBe(true);

    panel.remove();
    const { panel: restored, provider, context } = await mountPanel();
    await update(restored, { custodianSuppressed: false, pageRouteId: "updates" });
    expect(restored.assistantPanelOpen).toBe(false);
    provider.setContext({ ...context });
    await restored.updateComplete;
    expect(restored.assistantPanelOpen).toBe(false);
    window.dispatchEvent(new CustomEvent(CUSTODIAN_PANEL_TOGGLE_EVENT));
    await restored.updateComplete;
    expect(restored.assistantPanelOpen).toBe(true);
    provider.setContext({ ...context });
    await restored.updateComplete;
    expect(restored.assistantPanelOpen).toBe(true);
    await update(restored, { pageRouteId: "agents-home" });
    expect(restored.assistantPanelOpen).toBe(true);
  });

  it.each(["right", "bottom"])("drags only passive header chrome when docked %s", async (dock) => {
    const { panel, dom } = await mountPanel({ custodianSuppressed: false });
    await toggle(panel, CUSTODIAN_PANEL_TOGGLE_EVENT, { open: true, dock });

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
      const target = dom.query(selector);
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

    await click(panel, ".assistant-panel-actions button:first-child");
    expect(dom.query(`.assistant-panel--${dock === "right" ? "bottom" : "right"}`)).not.toBeNull();
    await click(panel, ".assistant-panel-actions button:last-child");
    expect(panel.assistantPanelOpen).toBe(false);
  });

  it.each([false, true])(
    "updates mascot and dock ownership after source replacement=%s",
    async (replace) => {
      const { panel, store, context } = await mountPanel();
      const currentStore = replace ? new CustodianSessionStore() : store;
      const currentContext = replace ? { ...context, assistantDock: new AssistantDock() } : context;
      if (replace) {
        panel.context = currentContext;
        panel.store = currentStore;
      }
      currentStore.messages = [
        { id: 1, role: "user", text: "Check this system", at: 1, question: null, step: null },
      ];
      panel.custodianSuppressed = false;
      panel.minimizeRequestId = 1;
      await panel.updateComplete;

      currentStore.sending = true;
      currentStore.setInput("status");
      await panel.updateComplete;

      expect(
        panel.querySelector<HTMLElement & { mood: string }>(
          ".assistant-panel-title openclaw-mascot",
        )?.mood,
      ).toBe("thinking");
      if (replace) {
        expect(() =>
          context.assistantDock.openSession(
            { sessionKey: "stale", agentId: "main", label: "Stale" },
            {},
          ),
        ).toThrow("conversation dock is unavailable");
        openReview(currentContext.assistantDock);
        await panel.updateComplete;
        expect(home(panel)?.sessionKey).toBe("agent:research:review");
      }
    },
  );
});
