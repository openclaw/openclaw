/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createContext,
  createGatewayHarness,
  createSessions,
  createSidebarElement,
} from "../test-helpers/app-sidebar.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "../test-helpers/app-sidebar-cases/basics.ts";
import "../test-helpers/app-sidebar-cases/footer-status.ts";
import "../test-helpers/app-sidebar-cases/group-mutations.ts";
import "../test-helpers/app-sidebar-cases/interactions.ts";
import "../test-helpers/app-sidebar-cases/new-group-dialog.ts";
import "../test-helpers/app-sidebar-cases/section-reordering.ts";
import "../test-helpers/app-sidebar-cases/session-delete-access.ts";
import "../test-helpers/app-sidebar-cases/session-mutations.ts";
import "../test-helpers/app-sidebar-cases/sidebar-scroll.ts";
import "../test-helpers/app-sidebar-cases/transient-menus.ts";

it("resolves sidebar rows before agent selection is available", async () => {
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  gateway.publish({ phase: "stopped", assistantAgentId: null, sessionKey: "" });
  const context = createContext(gateway.gateway, createSessions("main", []));
  context.agentSelection.set(null);
  const provider = createApplicationContextProvider(context);
  const sidebar = await createSidebarElement();
  const key = "agent:main:main";
  sidebar.sessionKey = key;
  provider.append(sidebar.hostElement);
  document.body.append(provider);
  await sidebar.updateComplete;
  sidebar.sessionData.sessionsAgentId = "main";
  sidebar.sessionData.sessionsResult = {
    ts: 1,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [{ key, kind: "direct", updatedAt: 1 }],
  };
  const navigation = sidebar.getSessionNavigationState();
  expect(navigation.selectedAgentId).toBe("main");
  expect(navigation.activeRowKey).toBe(key);
  expect(navigation.visibleSessionRows.map((row) => row.key)).toEqual([key]);
});
