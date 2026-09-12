/* @vitest-environment jsdom */

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult, GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  createAgentSelectionCapability,
  selectApplicationSession,
} from "../app/agent-selection.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { sessionsResult } from "../lib/sessions/session-capability.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createContext,
  createGatewayHarness,
  mountSidebarContext,
} from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./app-sidebar.ts";

describe("sidebar routed-lineage freshness", () => {
  it.each([
    "outside Work page",
    "foreign cached winner",
    "owned cached parent",
    "qualified parent owner",
  ] as const)("resolves the routed child's former global ancestor (%s)", async (scenario) => {
    const qualified = scenario === "qualified parent owner";
    const paged = scenario === "outside Work page" || scenario === "foreign cached winner";
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }, { id: "work" }, { id: "research" }],
    } satisfies AgentsListResult;
    const parent: GatewaySessionRow = {
      key: qualified ? "agent:research:dashboard:10000000-0000-4000-8000-000000000001" : "global",
      agentId: qualified ? "research" : "work",
      sessionId: "owned-parent-session",
      kind: qualified ? "direct" : "global",
      label: "Owned parent conversation",
      updatedAt: 1,
      archived: false,
    };
    const child: GatewaySessionRow = {
      key: "agent:work:dashboard:20000000-0000-4000-8000-000000000001",
      agentId: "work",
      sessionId: "work-fork-session",
      kind: "direct",
      label: "Selected Work fork",
      parentSessionKey: parent.key,
      updatedAt: 1_000,
      archived: false,
    };
    const foreign: GatewaySessionRow = {
      ...parent,
      agentId: "main",
      sessionId: "main-global-session",
      label: "Foreign Main conversation",
      updatedAt: 900,
    };
    const workRows = paged
      ? [
          child,
          ...Array.from({ length: 199 }, (_, index): GatewaySessionRow => ({
            key: `agent:work:dashboard:30000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            agentId: "work",
            sessionId: `work-page-${index}`,
            kind: "direct",
            updatedAt: 500 - index,
            archived: false,
          })),
        ]
      : scenario === "owned cached parent"
        ? [child, parent]
        : [child];
    const workPage: SessionsListResult = {
      ...sessionsResult(workRows, 2_000),
      totalCount: workRows.length + (paged ? 1 : 0),
      limitApplied: 200,
      hasMore: paged,
      nextOffset: paged ? 200 : null,
    };
    const requireRecord = createRequireRecord("object", "expected-label");
    const request = vi.fn(async (method: string, raw?: unknown) => {
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.groups.list") {
        return { names: [], sectionOrder: [] };
      }
      if (method === "models.list") {
        return { models: [] };
      }
      const params = requireRecord(raw, `${method} params`);
      if (method === "sessions.list") {
        if (params.spawnedBy) {
          return sessionsResult(
            params.spawnedBy === parent.key && (!params.agentId || params.agentId === child.agentId)
              ? [child]
              : [],
            2_000,
          );
        }
        if (params.agentId === "work") {
          return workPage;
        }
        expect(scenario).toBe("foreign cached winner");
        expect(params.agentId).toBeUndefined();
        return {
          ...workPage,
          ...sessionsResult([child, foreign, ...workRows.slice(1, 199)], 2_001),
        };
      }
      if (method === "sessions.describe") {
        if (params.key === child.key) {
          return { session: child };
        }
        expect(params.key).toBe(parent.key);
        if (!qualified && !params.agentId) {
          throw new Error(
            'Multiple agents are configured, but session key "global" has no explicit owner. Pass agentId or use an agent-prefixed session key.',
          );
        }
        expect(params.agentId === undefined || params.agentId === parent.agentId).toBe(true);
        return { session: parent };
      }
      throw new Error(`Unexpected Gateway method: ${method}`);
    });
    const harness = createGatewayHarness(createTestGatewayClient(request));
    const { gateway } = harness;
    harness.publish({
      hello: {
        ...gatewayHelloForMethods(["sessions.list", "sessions.describe", "sessions.subscribe"]),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      },
      sessionKey: "agent:work:main",
    });
    gateway.setSessionKey = (sessionKey) => harness.publish({ sessionKey });
    const selection = createAgentSelectionCapability(
      gateway,
      {
        state: { agentsList },
        subscribe: () => () => undefined,
      },
      { load: () => "work", save: () => undefined },
    );
    const sessions = createSessionCapability(gateway, selection);
    const context = { ...createContext(gateway, sessions, agentsList), agentSelection: selection };
    const { provider, sidebar } = await mountSidebarContext(context, "panel", "sessions");
    sidebar.connected = true;
    try {
      harness.publish({});
      await waitForFast(() =>
        expect(sessions.state.result?.sessions).toHaveLength(workRows.length),
      );
      expect(sessions.state.agentId).toBe("work");
      if (scenario === "foreign cached winner") {
        // Startup recovery can publish an unscoped primary snapshot while Work stays selected.
        await sessions.refresh({ force: true, backgroundHydrate: true });
        expect(sessions.state.agentId).toBeNull();
        expect(sessions.state.result?.sessions.find((row) => row.key === "global")?.agentId).toBe(
          "main",
        );
        expect(selection.state.selectedId).toBe("work");
      }
      selectApplicationSession({ selection, gateway, sessionKey: child.key });
      sidebar.activeRouteId = "chat";
      sidebar.sessionKey = child.key;
      await sidebar.sessionData.loadActiveSessionLineage(child.key);
      await sidebar.updateComplete;
      // Reveal the loaded section without fetching the next Gateway page.
      for (let page = 0; page < 20; page += 1) {
        const showMore = sidebar.querySelector<HTMLButtonElement>(
          '.sidebar-session-pagination__button[aria-label="Show more"]',
        );
        if (!showMore) {
          break;
        }
        showMore.click();
        await sidebar.updateComplete;
      }
      expect(
        sidebar.querySelector('.sidebar-session-pagination__button[aria-label="Show more"]'),
      ).toBeNull();
      if (paged) {
        expect(
          sessions.state.result?.sessions.some(
            (row) => row.key === parent.key && row.agentId === parent.agentId,
          ),
        ).toBe(false);
      }
      const parentRow = sidebar.querySelector(`[data-session-key="${parent.key}"]`);
      expect.soft(parentRow?.textContent ?? "").toContain(parent.label);
      expect.soft(sidebar.textContent).not.toContain(foreign.label);
      expect(
        sidebar.querySelector(`[data-session-key="${child.key}"]`)?.textContent ?? "",
      ).toContain(child.label);
      expect(sidebar.sessionKey).toBe(child.key);
      expect(selection.state.selectedId).toBe("work");
      if (scenario === "owned cached parent") {
        expect(request.mock.calls.filter(([method]) => method === "sessions.describe")).toEqual([]);
      }
    } finally {
      provider.remove();
      sessions.dispose();
      await sidebar.updateComplete;
    }
  });
});
