/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
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

it.each([0, 1])("resolves %i sidebar rows before agent selection is available", (count) => {
  const sidebar = document.createElement("openclaw-app-sidebar");
  if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
    throw new Error("expected the registered sidebar");
  }
  const key = "agent:main:main";
  sidebar.sessionKey = key;
  sidebar.sessionData.sessionsAgentId = "main";
  sidebar.sessionData.sessionsResult = {
    ts: 1,
    path: "",
    count,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: count === 0 ? [] : [{ key, kind: "direct", updatedAt: 1 }],
  };
  const navigation = sidebar.getSessionNavigationState();
  expect(navigation.selectedAgentId).toBe("main");
  expect(navigation.activeRowKey).toBe(key);
  expect(navigation.visibleSessionRows.map((row) => row.key)).toEqual([key]);
});
