/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { createChatSubmissions } from "../app/chat-submissions.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";

it.each(["chip", "roster"] as const)(
  "projects the visible pending agent in %s mode without admitting its selection",
  async (mode) => {
    const gateway = createGatewayHarness(createTestGatewayClient(async () => ({})));
    const context = {
      ...createContext(gateway.gateway, createSessions("main", ["agent:main:main"]), {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Harbor" },
          { id: "scout", name: "Scout" },
        ],
      }),
      chatSubmissions: createChatSubmissions(),
    };
    const { sidebar } = await mountSidebarContext(context, "panel", "chat");
    sidebar.sidebarAgentsMode = mode;
    const savedSessionKey = gateway.gateway.snapshot.sessionKey;
    const savedSelection = context.agentSelection.state.selectedId;
    context.agents.state.pendingAgent = { id: "bot-pending", name: "New agent" };
    sidebar.sessionKey = "agent:bot-pending:main";
    const release = context.chatSubmissions.beginCreate({
      creation: { sessionKey: sidebar.sessionKey, admitted: false },
      message: null,
      canDisplay: () => true,
    });
    await settleLitElement(sidebar);

    expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent).toContain(
      mode === "chip" ? "New agent" : "OpenClaw",
    );
    sidebar
      .querySelector<HTMLButtonElement>(
        mode === "chip" ? ".sidebar-agent-card__main" : ".sidebar-workspace-header__main",
      )!
      .click();
    await settleLitElement(sidebar);
    expect(sidebar.querySelector('[data-value^="agent:"]')?.getAttribute("data-value")).toBe(
      "agent:bot-pending",
    );
    expect(
      sidebar.querySelector('[data-value="agent:bot-pending"]')?.getAttribute("aria-current"),
    ).toBe(mode === "chip" ? "true" : null);
    expect(
      sidebar.querySelector('[data-value="agent:main"]')?.getAttribute("aria-current"),
    ).not.toBe("true");
    expect(sidebar.querySelector('[data-value="scope:all"]')?.getAttribute("aria-current")).toBe(
      mode === "roster" ? "true" : null,
    );
    expect(sidebar.activeChipAgent().agents.map((agent) => agent.id)).toEqual(["main", "scout"]);
    expect(context.agentSelection.state.selectedId).toBe(savedSelection);
    expect(gateway.gateway.snapshot.sessionKey).toBe(savedSessionKey);

    sidebar.sidebarMenus.closeAgentMenu();
    sidebar.sessionKey = savedSessionKey;
    release();
    await settleLitElement(sidebar);
    expect(sidebar.activeChipAgent().activeId).toBe("main");
    expect(sidebar.querySelector(".sidebar-agent-card__name")?.textContent ?? "").not.toContain(
      "New agent",
    );
    expect(sidebar.sidebarAgentsMode).toBe(mode);
  },
);
