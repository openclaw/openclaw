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
import { selectSessionMenuValue } from "../test-helpers/app-sidebar-menu.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import "./app-sidebar.tsx";

function session(
  key: string,
  ownerId: string,
  extra: Partial<GatewaySessionRow> = {},
): GatewaySessionRow {
  return {
    key,
    agentId: key.split(":")[1],
    kind: "direct",
    owner: { actor: { type: "human", id: ownerId } },
    ...extra,
  };
}

it("keeps selected owners across agents and resumes the selected agent's own conversation", async () => {
  const rows: GatewaySessionRow[] = [
    session("agent:main:mine", "viewer", { label: "My working session" }),
    session("agent:research:shared", "other", {
      label: "Another user's shared session",
      updatedAt: 3000,
      unread: true,
    }),
    session("agent:research:dashboard:00000002-0000-4000-8000-000000000000", "viewer", {
      label: "My research session",
      updatedAt: 2000,
      unread: true,
    }),
    session("agent:research:main", "viewer", {
      updatedAt: 1000,
      hasActiveRun: true,
      status: "running",
    }),
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
  const sidebar = await createSidebarElement();
  sidebar.activeRouteId = "chat";
  sidebar.sidebarAgentsMode = "chip";
  provider.append(sidebar.hostElement);
  document.body.append(provider);
  const visit = async (row: GatewaySessionRow, refresh = true) => {
    bindChatPageSession(context, row.key);
    sidebar.sessionKey = row.key;
    await settleLitElement(sidebar);
    if (refresh) {
      await sidebar.sessionData.refreshSidebarSessions();
      await settleLitElement(sidebar);
    }
  };
  try {
    sidebar.connected = true;
    for (const row of [rows[1]!, rows[0]!, rows[1]!]) {
      await visit(row);

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

    await visit(rows[0]!);

    // Named owners retain cross-agent scope even when the open agent has no rows.
    await sidebar.sidebarMenus.preloadMenuRenderer();
    await selectSessionMenuValue(sidebar, "status:all");
    await selectSessionMenuValue(sidebar, "owner:other");
    await settleLitElement(sidebar);
    expect(sidebar.getRouteSessionKey()).toBe("agent:main:mine");
    expect(sidebar.querySelector('[data-session-key="agent:research:shared"]')).not.toBeNull();
    expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).toBeNull();
    await selectSessionMenuValue(sidebar, "owner:viewer");

    const onNavigate = vi.fn();
    sidebar.onNavigate = onNavigate;
    await sidebar.sidebarMenus.preloadMenuRenderer();
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await settleLitElement(sidebar);
    const researchMenuItem = sidebar.querySelector<HTMLElement>(
      '.sidebar-agent-menu [data-value="agent:research"]',
    )!;
    expect.soft(researchMenuItem.querySelector('[aria-label="Unread"]')).not.toBeNull();
    researchMenuItem.click();
    await vi.waitFor(() =>
      expect(onNavigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          pathname: "/chat/research/00000002000040008000000000000000",
        }),
      ),
    );

    await visit(rows[2]!, false);
    const home = sidebar.querySelector<HTMLElement>(".sidebar-footer-bar__home")!;
    expect.soft(home.querySelector('[aria-label="Active run"]')).not.toBeNull();

    rows[2]!.unread = false;
    await visit(rows[0]!);
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")!.click();
    await settleLitElement(sidebar);
    expect(
      sidebar.querySelector(
        '.sidebar-agent-menu [data-value="agent:research"] [aria-label="Unread"]',
      ),
    ).toBeNull();
  } finally {
    provider.remove();
    context.connectionBootstrap.reset();
    sessions.dispose();
  }
});
