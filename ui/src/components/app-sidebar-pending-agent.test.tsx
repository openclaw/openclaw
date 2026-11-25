/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { makeBootRoster } from "../app/bootstrap.test-support.ts";
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
      ...createContext(
        gateway.gateway,
        createSessions("main", ["agent:main:main"]),
        makeBootRoster({
          agents: [
            { id: "main", name: "Harbor" },
            { id: "scout", name: "Scout" },
          ],
        }),
      ),
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

    const rowName = () =>
      sidebar.querySelector(".sidebar-agent-roster--selected .sidebar-agent-roster__name")
        ?.textContent ?? "";
    // Only the one-agent list leads with its agent; the roster keeps its configured agents.
    expect(rowName()).toBe(mode === "chip" ? "New agent" : "");
    expect(sidebar.activeChipAgent().agents.map((agent) => agent.id)).toEqual(["main", "scout"]);
    expect(context.agentSelection.state.selectedId).toBe(savedSelection);
    expect(gateway.gateway.snapshot.sessionKey).toBe(savedSessionKey);

    sidebar.sessionKey = savedSessionKey;
    release();
    await settleLitElement(sidebar);
    expect(sidebar.activeChipAgent().activeId).toBe("main");
    expect(rowName()).not.toContain("New agent");
    expect(sidebar.sidebarAgentsMode).toBe(mode);
  },
);
