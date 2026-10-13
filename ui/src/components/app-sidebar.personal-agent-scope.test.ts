/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { bindChatPageSession } from "../pages/chat/chat-state-route.ts";
import "../test-helpers/app-sidebar-suite.ts";
import { createContext, createGatewayHarness, TWO_AGENTS } from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import "./app-sidebar.ts";

it("keeps My sessions across agents and resumes the selected agent's own conversation", async () => {
  const rows: GatewaySessionRow[] = [
    {
      key: "agent:main:mine",
      agentId: "main",
      kind: "direct",
      label: "My working session",
      owner: { actor: { type: "human", id: "viewer" } },
    },
    {
      key: "agent:research:shared",
      agentId: "research",
      kind: "direct",
      label: "Another user's shared session",
      updatedAt: 3000,
      unread: true,
      owner: { actor: { type: "human", id: "other" } },
    },
    {
      key: "agent:research:dashboard:00000002-0000-4000-8000-000000000000",
      agentId: "research",
      kind: "direct",
      label: "My research session",
      updatedAt: 2000,
      unread: true,
      owner: { actor: { type: "human", id: "viewer" } },
    },
    {
      key: "agent:research:main",
      agentId: "research",
      kind: "direct",
      updatedAt: 1000,
      hasActiveRun: true,
      status: "running",
      owner: { actor: { type: "human", id: "viewer" } },
    },
  ];
  const gateway = createGatewayHarness(
    createTestGatewayClient(async (method, raw) => {
      const params = asOptionalRecord(raw);
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.describe") {
        return { session: rows.find((row) => row.key === params?.key) ?? null };
      }
      if (method === "sessions.groups.list") {
        return { names: [], groups: [], sectionOrder: [] };
      }
      if (method !== "sessions.list") {
        return {};
      }
      const selected = rows.filter(
        (row) =>
          (!params?.agentId || row.agentId === params.agentId) &&
          (!params?.ownerId || row.owner?.actor.id === params.ownerId),
      );
      return {
        ...sessionsResult(selected, 1),
        owners: [
          { type: "human", id: "viewer", label: "Viewer" },
          { type: "human", id: "other", label: "Other" },
        ],
      };
    }),
  );
  gateway.publish({ selfUser: { id: "viewer", name: "Viewer" } });
  const sessions = createTestSessionCapability(gateway.gateway);
  await sessions.refresh({ agentId: "main", force: true });
  const context = createContext(gateway.gateway, sessions, TWO_AGENTS);
  const provider = createApplicationContextProvider(context);
  const sidebar = document.createElement("openclaw-app-sidebar");
  if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
    throw new Error("Expected registered sidebar");
  }
  sidebar.activeRouteId = "chat";
  sidebar.sidebarAgentsMode = "chip";
  provider.append(sidebar);
  document.body.append(provider);
  try {
    sidebar.connected = true;
    for (const row of [rows[1]!, rows[0]!, rows[1]!]) {
      bindChatPageSession(context, row.key);
      sidebar.sessionKey = row.key;
      await settleLitElement(sidebar);
      await sidebar.sessionData.refreshSidebarSessions();
      await settleLitElement(sidebar);

      expect(sidebar.sidebarSessionOwnerFilter()).toEqual({
        ownerId: "viewer",
        involvingMe: false,
      });
      expect(context.agentSelection.state.selectedId).toBe(row.agentId);
      expect(sidebar.getRouteSessionKey()).toBe(row.key);
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:research:shared"]')).toBeNull();
      expect(sidebar.querySelector(`[data-session-key="${rows[2]!.key}"]`)).not.toBeNull();
    }

    bindChatPageSession(context, rows[0]!.key);
    sidebar.sessionKey = rows[0]!.key;
    await settleLitElement(sidebar);
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);

    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    await sidebar.sidebarMenus.preloadMenuRenderer();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await settleLitElement(sidebar);
    const researchMenuItem = sidebar.querySelector<HTMLElement>(
      '.sidebar-agent-menu wa-dropdown-item[value="agent:research"]',
    )!;
    expect.soft(researchMenuItem.querySelector('[aria-label="Unread"]')).not.toBeNull();
    researchMenuItem.click();

    expect.soft(onNavigate).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({
        pathname: "/chat/research/00000002000040008000000000000000",
      }),
    );

    bindChatPageSession(context, rows[2]!.key);
    sidebar.sessionKey = rows[2]!.key;
    await settleLitElement(sidebar);
    const home = sidebar.querySelector<HTMLElement>(".sidebar-footer-bar__home")!;
    expect.soft(home.querySelector('[aria-label="Active run"]')).not.toBeNull();

    rows[2]!.unread = false;
    bindChatPageSession(context, rows[0]!.key);
    sidebar.sessionKey = rows[0]!.key;
    await settleLitElement(sidebar);
    await sidebar.sessionData.refreshSidebarSessions();
    await settleLitElement(sidebar);
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector('.sidebar-agent-menu [value="agent:research"] [aria-label="Unread"]'),
    ).toBeNull();
  } finally {
    provider.remove();
    context.connectionBootstrap.reset();
    sessions.dispose();
  }
});
