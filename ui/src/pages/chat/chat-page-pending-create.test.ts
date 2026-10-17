/* @vitest-environment jsdom */
import { afterEach, beforeAll, expect, it, vi } from "vitest";

// The page and pending renderer stay real; ordinary panes expose every presented session.
// mock-isolation: avoid starting Gateway-owned chat controllers for the transcript presentation test.
vi.mock("./chat-pane.tsx", async () => {
  const { mockChatPagePane } = await import("./chat-page-pane.test-support.ts");
  return { ChatPaneView: mockChatPagePane };
});

import { loadSettings, patchSettings } from "../../app/settings.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createSplitLayout,
  setNavigationContext,
  settleChatPage,
  stubMatchMedia,
} from "./chat-page.test-support.ts";
import { ChatPage } from "./chat-page.ts";
import { PendingSessionCreate } from "./pending-session-create-lazy.ts";

const presentedSessions: string[] = [];
class TranscriptPane extends HTMLElement {
  sessionKey = "";
  private isPresented = false;
  private isActive = false;
  set presented(value: boolean) {
    this.isPresented = value;
    this.recordPresentation();
  }
  set active(value: boolean) {
    this.isActive = value;
    this.recordPresentation();
  }
  private recordPresentation() {
    if (this.isPresented && this.isActive) {
      presentedSessions.push(this.sessionKey);
      this.textContent = `Transcript: ${this.sessionKey}`;
    }
  }
}
customElements.define("openclaw-chat-pane", TranscriptPane);

// These page-only fixtures bypass the selector/router that prepares the pending view.
beforeAll(async () => {
  await PendingSessionCreate.preload();
});

afterEach(() => {
  document.body.replaceChildren();
  presentedSessions.length = 0;
  vi.unstubAllGlobals();
});

it.each([
  { split: false, agentCreation: true },
  { split: true, agentCreation: true },
  { split: false, agentCreation: false },
])(
  "replaces the previous transcript throughout creation and admission (split: $split, agent: $agentCreation)",
  async ({ split, agentCreation }) => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
    const previousKey = "agent:main:main";
    const agentId = "bot-30c3b5be-7f13-4057-866c-17b3c6d51896";
    const sessionKey = `agent:${agentId}:main`;
    if (split) {
      patchSettings({ chatSplitLayout: createSplitLayout(previousKey) });
    }
    const page = new ChatPage();
    const { context } = setNavigationContext(page);
    Object.assign(context, { theme: { subscribe: () => () => undefined } });
    Object.assign(context.agents, { subscribe: () => () => undefined });
    Object.assign(context.gateway.snapshot, { phase: "connected" });
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Previous agent" }],
    };
    page.data = { sessionKey: previousKey };
    document.body.append(page);
    await settleChatPage(page);
    expect(page.textContent).toContain(`Transcript: ${previousKey}`);

    const creation = { sessionKey, admitted: false };
    const displayName = agentCreation ? "New agent" : "New conversation";
    context.agents.state.pendingAgent = agentCreation
      ? { id: agentId, name: displayName }
      : undefined;
    const clear = context.chatSubmissions.beginCreate({
      creation,
      displayName,
      message: null,
      canDisplay: () => true,
    });
    page.data = { sessionKey, agentId, creation, face: "chat" };
    await settleChatPage(page);
    await settleChatPage(page);
    expect(page.querySelector("openclaw-pending-session-create")).not.toBeNull();
    expect(page.textContent).toContain(displayName);
    expect(page.querySelector(".chat-thread-inner .chat-working-indicator")?.textContent).toContain(
      agentCreation ? "Creating new agent…" : "Starting…",
    );
    if (!agentCreation) {
      expect(page.textContent).not.toContain("Creating new agent…");
      expect(page.textContent).not.toContain("Hi! What would you like to call me?");
    } else {
      expect(page.querySelector(".chat-group.assistant .chat-text")?.textContent?.trim()).toBe(
        "Hi! What would you like to call me?",
      );
    }
    expect(page.textContent).not.toContain("Reconnecting");
    expect(page.querySelector(".chat-pane-cache__pane--visible")?.textContent).not.toContain(
      "Transcript:",
    );
    expect(page.textContent).not.toContain(agentId);
    expect(page.querySelector(".chat-group.user")).toBeNull();

    presentedSessions.length = 0;
    context.agents.state.agentsList.agents.push({ id: agentId, name: displayName });
    context.agents.state.pendingAgent = undefined;
    creation.admitted = true;
    clear();
    await settleChatPage(page);
    await settleChatPage(page);
    expect(page.querySelector("openclaw-pending-session-create")).toBeNull();
    expect(presentedSessions).toContain(sessionKey);
    expect(presentedSessions).not.toContain(previousKey);
    expect(context.gateway.setSessionKey).toHaveBeenLastCalledWith(sessionKey);
  },
);

it.each(["rollback", "admission"] as const)(
  "preserves restored unbound panes through pending creation and %s",
  async (outcome) => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    stubMatchMedia(false);
    const previousKey = outcome === "rollback" ? "global" : "agent:main:main";
    const unboundPaneId = outcome === "rollback" ? "p1" : "p2";
    patchSettings({
      chatSplitLayout: {
        activePaneId: "p1",
        columnWeights: outcome === "rollback" ? [1] : [0.5, 0.5],
        columns: [
          { id: "c1", paneWeights: [1], panes: [{ id: "p1", sessionKey: previousKey }] },
          ...(outcome === "admission"
            ? [{ id: "c2", paneWeights: [1], panes: [{ id: "p2", sessionKey: "global" }] }]
            : []),
        ],
      },
    });
    const page = new ChatPage();
    const { context } = setNavigationContext(page);
    Object.assign(context, { theme: { subscribe: () => () => undefined } });
    Object.assign(context.agents, { subscribe: () => () => undefined });
    Object.assign(context.gateway.snapshot, { phase: "connected" });
    context.agents.state.agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", name: "Previous agent" }],
    };
    const previousRoute = { sessionKey: previousKey };
    page.data = previousRoute;
    document.body.append(page);
    await settleChatPage(page);
    expect(page.querySelector(`[data-unbound-pane-id="${unboundPaneId}"]`)).not.toBeNull();

    const agentId = "bot-new-agent";
    const sessionKey = `agent:${agentId}:main`;
    const creation = { sessionKey, admitted: false };
    context.agents.state.pendingAgent = { id: agentId, name: "New agent" };
    const clear = context.chatSubmissions.beginCreate({
      creation,
      displayName: "New agent",
      message: null,
      canDisplay: () => true,
    });
    page.data = { sessionKey, agentId, creation, face: "chat" };
    await settleChatPage(page);
    expect(page.querySelector("openclaw-pending-session-create")).not.toBeNull();
    expect(page.querySelector(".chat-pane-cache__pane--visible")?.textContent).not.toContain(
      "Transcript:",
    );

    context.agents.state.pendingAgent = undefined;
    if (outcome === "admission") {
      context.agents.state.agentsList.agents.push({ id: agentId, name: "New agent" });
      creation.admitted = true;
    } else {
      page.data = previousRoute;
    }
    clear();
    await settleChatPage(page);
    await settleChatPage(page);
    expect(page.querySelector("openclaw-pending-session-create")).toBeNull();
    expect(page.querySelector(`[data-unbound-pane-id="${unboundPaneId}"]`)).not.toBeNull();
    expect(
      loadSettings()
        .chatSplitLayout?.columns.flatMap((column) => column.panes)
        .find((pane) => pane.id === unboundPaneId)?.sessionKey,
    ).toBe("global");
    if (outcome === "rollback") {
      expect(page.querySelector("openclaw-chat-pane")).toBeNull();
    } else {
      expect(page.querySelector(".chat-pane-cache__pane--visible")?.textContent).toContain(
        `Transcript: ${sessionKey}`,
      );
    }
  },
);
