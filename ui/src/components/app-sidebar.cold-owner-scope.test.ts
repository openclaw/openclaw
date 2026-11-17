/* @vitest-environment jsdom */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { consumeSessionNavigationHandoff } from "../lib/sessions/navigation-handoff.ts";
import {
  createTestSessionCapability,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { bindChatPageSession } from "../pages/chat/chat-state-route.ts";
import { ownedSession, viewer } from "../test-helpers/agent-sidebar.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  createSidebarElement,
  TWO_AGENTS,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { storeSidebarSessionOwnerFilter } from "./app-sidebar-session-types.ts";

it.each(["unavailable", "one agent"])(
  "restores cross-agent My sessions after the %s roster arrives and keeps them through a real selection refresh",
  async (initialRoster) => {
    const rows: GatewaySessionRow[] = [
      ownedSession("agent:main:mine", viewer.id, { label: "Main conversation" }),
      ownedSession("agent:research:mine", viewer.id, { label: "Research conversation" }),
      ownedSession("agent:research:second", viewer.id, { label: "Research second" }),
      {
        key: "agent:main:legacy",
        agentId: "main",
        kind: "direct" as const,
        label: "Legacy",
      },
    ];
    const roster = createDeferred<AgentsListResult>();
    let firstAgentRead = true;
    const gateway = createGatewayHarness(
      createTestGatewayClient(async (method, raw) => {
        const params = asOptionalRecord(raw);
        if (method === "agents.list") {
          if (firstAgentRead && initialRoster === "one agent") {
            firstAgentRead = false;
            return { ...TWO_AGENTS, agents: TWO_AGENTS.agents.slice(0, 1) };
          }
          return roster.promise;
        }
        if (method === "sessions.subscribe") {
          return { subscribed: true };
        }
        if (method === "sessions.describe") {
          return { session: rows.find((row) => row.key === params?.key) ?? null };
        }
        if (method === "sessions.groups.list") {
          return { names: [], groups: [], sectionOrder: [] };
        }
        if (method === "sessions.list") {
          const selected = rows.filter(
            (row) =>
              (!params?.agentId || row.agentId === params.agentId) &&
              (!params?.ownerId || row.owner?.actor.id === params.ownerId),
          );
          return { ...sessionsResult(selected), owners: [viewer] };
        }
        return {};
      }),
    );
    const hello = gateway.gateway.snapshot.hello!;
    gateway.publish({
      selfUser: { id: viewer.id, name: viewer.label },
      hello: { ...hello, policy: { ...hello.policy, hasMultipleSessionSharingIdentities: false } },
    });
    storeSidebarSessionOwnerFilter(gateway.gateway.connection.gatewayUrl, viewer.id, {
      ownerId: viewer.id,
      involvingMe: false,
    });
    const agents = createAgentCapability(gateway.gateway);
    const initialRead = agents.ensureList();
    if (initialRoster === "one agent") {
      await initialRead;
    }
    const sessions = createTestSessionCapability(gateway.gateway);
    await sessions.refresh({ agentId: "main", force: true });
    const baseContext = createContext(gateway.gateway, sessions);
    sessions.dispose();
    const liveSessions = createSessionCapability(gateway.gateway, baseContext.agentSelection);
    await liveSessions.refresh({ agentId: "main", force: true });
    const context = { ...baseContext, sessions: liveSessions, agents };
    const provider = createApplicationContextProvider(context);
    const sidebar = await createSidebarElement();
    sidebar.activeRouteId = "chat";
    sidebar.sidebarAgentsMode = "chip";
    provider.append(sidebar.hostElement);
    document.body.append(provider);
    try {
      sidebar.connected = true;
      await settleLitElement(sidebar);
      expect(sidebar.querySelector('[data-session-key="agent:main:mine"]')).not.toBeNull();
      expect(sidebar.querySelector('[data-session-key="agent:research:mine"]')).toBeNull();
      expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
      const completeRead = initialRoster === "one agent" ? agents.refreshList() : initialRead;
      // The production agent owner publishes the completed RPC after the initial sidebar mount.
      roster.resolve(TWO_AGENTS);
      await completeRead;
      await waitForSolid(() => {
        for (const row of rows) {
          expect(
            sidebar.querySelector('[data-session-key="' + row.key + '"]'),
            row.key,
          ).not.toBeNull();
        }
      });
      expect(context.agentSelection.state.selectedId).toBe("main");
      sidebar.onNavigate = (_route, options) => {
        const key = consumeSessionNavigationHandoff(context.gateway, options!.pathname!);
        bindChatPageSession(context, key!);
        sidebar.sessionKey = key!;
      };
      sidebar
        .querySelector<HTMLAnchorElement>(
          '[data-session-key="agent:research:mine"] .sidebar-recent-session__link',
        )!
        .click();
      await waitForSolid(() => expect(context.agentSelection.state.selectedId).toBe("research"));
      await liveSessions.refresh({ agentId: "research", force: true });
      expect(liveSessions.state.agentId).toBe("research");
      expect(sidebar.sessionData.sessionListQuery("research").agentId).toBeUndefined();
      await waitForSolid(() => {
        for (const row of rows) {
          expect(
            sidebar.querySelector('[data-session-key="' + row.key + '"]'),
            row.key,
          ).not.toBeNull();
        }
      });
      expect(sidebar.sessionOwnerFilter.read().ownerId).toBe(viewer.id);
      expect(sidebar.sidebarSessionOwnerFilter()).toEqual({ ownerId: null, involvingMe: false });
    } finally {
      provider.remove();
      context.connectionBootstrap.reset();
      liveSessions.dispose();
      agents.dispose();
    }
  },
);
