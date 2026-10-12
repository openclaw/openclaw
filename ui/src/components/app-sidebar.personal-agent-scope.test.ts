/* @vitest-environment jsdom */

import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
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

it("keeps My sessions across configured agents when viewing another user's session", async () => {
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
      owner: { actor: { type: "human", id: "other" } },
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
    }
  } finally {
    provider.remove();
    context.connectionBootstrap.reset();
    sessions.dispose();
  }
});
